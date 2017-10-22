// Although me and a friend had worked on previous hot-code reloading.
// This module was highly inspired by a few other hot-reload modules and info.
// In no particular order.
//
// https://stackoverflow.com/questions/9210542/node-js-require-cache-possible-to-invalidate
//
// hot-require by Surui
// https://github.com/rayosu/hot-require
//
// require-reload by James Hartig
// https://github.com/fastest963/require-reload
//
// node-hot by Mikael Hermansson
// https://github.com/mihe/node-hot
// The state store & restore as well as the accepting reload concepts are nice!
// But did not over-write prototypes or emit to us when it had reloaded.
// Also it muddyed up the log with its own messages.
//
// invalidate-module by Kenneth Chung
// https://github.com/kentor/invalidate-module
// And his nice blog post on this subject.
// https://kentor.me/posts/node-js-hot-reloading-development/
//
// https://medium.com/@gattermeier/invalidate-node-js-require-cache-c2989af8f8b0
//
// require-from-string by floatdrop gave us more of an insight on implementing our own require method as well as loading from text string.
// https://github.com/floatdrop/require-from-string
//
// Initially we had made a module to re-load code using vm script functionality of node.js
// to execute in a context.
//
// But it would be more ideal to have something that is pretty seamless and clean rather than
// tightly coupled with the application. (So it could be removed or w/e if needed for producation).
//
// We needed a way to be notified when a file was re-loaded.
// Support for JSON as well, we get this for free now with just using require.
//
// Another requirement is that we needed prototypes and other keys that were exported to be updated on the old cache.
// So that old objects would call the new methods.
// They remained around in the application.
// We understood the risks of this concept.
//   1) Data might be wrong / not existent on old objects for when running new code.
//   2) Sync loading at runtime is not so good. (We don't care its to facilitate rapid development).
//   3) Infinite loop possibility if code would write to an already watched file during its require step.
//      Require cycle would never complete / error application when it maxs stack.
//      (Well the solution is simple here, don't overwrite those files from code during load...)
//   4) Deleting code or files could have unexpected results, code/modules still in use. (Again we don't care about that).
//   5) Restarting the server may be necessary at some points to get a clean state on all data.
//      We want this mostly for tweaks to scripts/files that could be reliably re-loaded.
//   6) Existing callback functions in use may use old code.
//   7) Timeouts or Intervals would use old code unless reset, or that code looks at exported function/prototype call each time.
//   8) Might not handle module exports structure change too well. (Keep it same or reset server)
//   9) Oddly enough, require cache may not be set instantly...
//
// You might think, just use nodemon, but that is kind of a pain in the ass when we want to hot-reload almost everything without restarting the application.
// Eg packet handling definitions, packet structures, database schema/models, json configs.
//
// Of course another design we could do would simply be to design the app to not retain state, and so each request would be on new code.
// But we have not yet fully commited to that idea, although it would probably be better for scaling.
// But during development we want to reload packet structure definitions and scripts to run logic based on user or AI actions.
//
//
// Some limitations are put in place.
//
// * Ignore the node_modules directory.
// * Don't do code that would open handles or start up listning servers or w/e in your reloadable modules.
//   Only in functions they export.
// * Used only once per project.
// * hotter-require won't reload its self.
//
// Read this for more info on modules. https://nodejs.org/api/modules.html

/*jshint esversion: 6 */

var EventEmitter = require('events');
// Note: Using chokidar for its cross platform support. I wonder if it is overkill though, but it does get the job done.
var chokidar = require('chokidar');
var path = require('path');
var fs = require('fs');

var Module = require('module');

// I wanted a way to pass the parent module.
function requireFromString(code, filename, opts) {
  if (typeof filename === 'object') {
    opts = filename;
    filename = undefined;
  }

  opts = opts || {};
  filename = filename || '';

  opts.appendPaths = opts.appendPaths || [];
  opts.prependPaths = opts.prependPaths || [];

  if (typeof code !== 'string') {
    throw new Error('code must be a string, not ' + typeof code);
  }

  var paths = Module._nodeModulePaths(path.dirname(filename));

  var parent = opts.parent || module.parent;
  var m = new Module(filename, parent);
  m.filename = filename;
  m.paths = [].concat(opts.prependPaths).concat(paths).concat(opts.appendPaths);
  m._compile(code, filename);

  var exports = m.exports;
  if (parent.children) {
    parent.children.splice(parent.children.indexOf(m), 1);
  }

  return exports;
}


var DepGraph = require('dependency-graph').DepGraph;

// Used to stop re-init.
var selfCache = null;

module.exports = function(options) {
  if (selfCache) {
    return selfCache;
  }

  if (options === undefined) {
    options = {};
  }

  if (options.persistent === undefined) {
    options.persistent = false;
  }
  if (options.awaitWriteFinish === undefined) {
    options.awaitWriteFinish = {
      stabilityThreshold: 250,
      pollInterval: 10
    };
  }

  options.directory = options.directory || '**/*.';
  options.watchedTypes = options.watchedTypes || ['js', 'json'];
  options.paths = options.paths || options.directory + '(' + options.watchedTypes.join('|') + ')';

  class HotReloadEmitter extends EventEmitter {}
  const emitter = new HotReloadEmitter();
  var watcher;

  function watch() {
    watcher = chokidar.watch(options.paths, {
      persistent: options.persistent,
      ignoreInitial: true,
      ignored: /node_modules|\.git/, // TODO: Any file beginning with . to cover other source controls?
      awaitWriteFinish: options.awaitWriteFinish,
      atomic: options.atomic || true,
      awaitWriteFinish: {
          stabilityThreshold: options.stabilityThreshold || 300,
          pollInterval: options.pollInterval || 50
      },
      interval: options.interval || 100,
      binaryInterval: options.binaryInterval || 300
    });

    // Note: It may take sometime for chokidar to be ready.
    // Generally it seems to be enough time before changes are made, but if you are running tests
    // Then you will want to wait for this event before continuing your applications code.
    watcher.on('ready', function() {
      emitter.emit('ready');
    });

    // Expose the watcher just in-case.
    emitter.watcher = watcher;

    watcher.on('change', function(modulePath) {
      emitter.emit('change', modulePath);
      // Option to not reload on prod? // if (process.env.NODE_ENV === 'production') {
      emitter.reload(modulePath);
      emitter.emit('post-change', modulePath);
    });
  }

  watch();

  // A way to disable watching on init.
  if (options.noWatch) {
    watcher.close();
  }

  this.stopWatching = function HotterRequire_stopWatching() {
    if (watcher) {
      watcher.close();
    }
    watcher = null;
  };

  this.startWatching = function HotterRequire_startWatching() {
    if (!watcher) {
      watch();
    }
  };

  // TODO: A way to pass in data either as text or buffer to use in place of require call?
  //       This would require re-writing to have same functionality as require without touching disk.

  // this.reload = function HotterRequire_reload(modulePath) {

  //   // Allow the user to reject a reload from listening to the change event and setting the feedback ignore flag to true.
  //   var feedback = { ignore: false };
  //   emitter.emit('change', modulePath, feedback);
  //   if (feedback.ignore === true) {
  //     return;
  //   }

  //   emitter.reload(modulePath);
  //   emitter.emit('post-change', modulePath);
  // }

  // This code modified from code by Kenneth Chung.
  const graph = new DepGraph(); // TODO: Remove graph if we will not use it?

  // Backup original require method.
  var __require = Module.prototype.require;
  // Allow to bypass our require method lookup, used if a file was not found with our naive lookup implementation.
  // This will allow a node_module path or native modules to load as needed with minimal fluffing about that would otherwise happen.
  var bypass_naive_lookup = false;
  var moduleExports;

  // Overwrite the require method on the Module prototype.
  Module.prototype.require = function(modulePath) {
    var resolvedModulePath = Module._resolveFilename(modulePath, this);
    if (bypass_naive_lookup) {

      if (graph.hasNode(resolvedModulePath)) {
        // TODO: Use require cache?
        moduleExports = graph.getNodeData(resolvedModulePath);
      } else {
        moduleExports = __require.call(this, modulePath);
      }

      // Store the exports.
      emitter.emit('loaded', modulePath, moduleExports);
      graph.addNode(resolvedModulePath, moduleExports);
      graph.addNode('FILE: ' + this.filename);
      graph.addDependency('FILE: ' + this.filename, resolvedModulePath);

      return moduleExports;
    }

    // A work around because weirdly sometimes the module is not in the cache straight away?
    //var requiredModule = __require.call(this, modulePath);
    // Note: Using dependency graph because each module has its own require cache but we want a shared one.
    if (graph.hasNode(resolvedModulePath)) {
      // TODO: Use require cache?
      moduleExports = graph.getNodeData(resolvedModulePath);
    } else {


      // A lot of TODO? things here, for now we will default to using normal require method if file not found from a simple lookup.
      // I haven't found a real need/want for this functionality just yet.
      // TODO: Look in each path.
      // TODO: Look at package.json if directory.
      // TODO: Look at index.js if directory.
      // TODO: Cache if directory exist so we don't need to fs.statSync as much?
      // TODO: Handle a folder require?
      // TODO: Handle node binary requires?
      // TODO: Handle URL paths?

      // Search for file to include.
      // If not found at all then try native binding?
      //process.binding('fs')

      // Will attempt to find file path for module relative or in node_modules dir.
      // If not found, then the real require method will be called.

      var tryPath = resolvedModulePath;
      var stat = null;
      var isJSON = false;

      // TODO: Squash / simplify this logic? 
      try {
        stat = fs.statSync(tryPath);
        // TODO: Check exception type?
      } catch (e) {
        // Assume not found. Because assumption based programming is best practice programming.
      }

      var extension = path.extname(modulePath);

      if (!stat && extension === '') {
        try {
          tryPath = resolvedModulePath + '.js';
          stat = fs.statSync(tryPath);
        } catch (e) {
          // not work.
        }

        if (!stat) {
          try {
            tryPath = resolvedModulePath + '.json';
            stat = fs.statSync(tryPath);
          } catch (e) {
            // not work.
          }
        }
      }

      if (!stat) {

        var paths = Module._nodeModulePaths(path.dirname(modulePath));
        for (var i = 0; i < paths.length; i++) {
          tryPath = path.resolve(paths[i], modulePath);
          try {
            stat = fs.statSync(tryPath);

            if (stat) {
              if (stat.isFile()) {
                break;
              }
            }

          } catch (e) {
            // Not work.
          }

          if (!stat && extension === '') {
            try {
              tryPath = path.resolve(paths[i], modulePath) + '.js';
              stat = fs.statSync(tryPath);
            } catch (e) {
              // not work.
            }

            if (!stat) {
              try {
                tryPath = path.resolve(paths[i], modulePath) + '.json';
                stat = fs.statSync(tryPath);
              } catch (e) {
                // not work.
              }
            }
          }

        }
      }

      if (stat && stat.isFile()) {
        var src = fs.readFileSync(tryPath, 'utf8');

        var isJSON = path.extname(tryPath) === '.json';
        if (isJSON) {
          moduleExports = JSON.parse(src);
        } else {
          moduleExports = requireFromString(src, tryPath, {
            parent: this
          });
        }
      } else {

        // This will handle native modules and other things not found by our above checks.
        //Object.keys(process.binding('natives')) // Hmn.. we can check if its a native module but require will do that for us too.
        if (!stat) {
          bypass_naive_lookup = true;
          moduleExports = __require.call(this, modulePath);
          bypass_naive_lookup = false;
        }
      }

      // Store the exports.
      emitter.emit('loaded', modulePath, moduleExports);
      graph.addNode(resolvedModulePath, moduleExports);
    }

    graph.addNode('FILE: ' + this.filename);
    graph.addDependency('FILE: ' + this.filename, resolvedModulePath);

    return moduleExports;
  };

  // TODO: A fix for circular references? Or we may get stuck in endless loop.
  function copyLeft(target, source) {
    /* TODO: Handle hacky things that has keys on it such as this:
      var a = {
        test: function(){}
      }

      a.test.bob = 1;
      module.exports(a);
    */

    var newDescriptors;
    var oldDescriptors;
    var key;

    if (target === undefined) {
      return;
    }
    if (source === undefined) {
      return;
    }

    // Note: May need to handle cases where type is changed between source and target...

    // Handle Array
    if (Array.isArray(source) && Array.isArray(target)) {
      // TODO: Loop through and copy over if applicable equality?
      // How to test equality for unknown elements...
      // lets just replace array for now?
      // TODO: Handle multi dimensional array?
      target.length = 0;
      source.forEach(function(element) {
        target.push(element);
      });
    }
    // Handle Object
    else if (source instanceof Object && target instanceof Object) {
      // We don't want to accidentally pollute Object.prototype.
      if (source.prototype === Object.prototype && target.prototype === Object.prototype) {

        // Copy over the new keys.
        for (key in source) {
          if (!target.hasOwnProperty(key)) {
            continue;
          }

          if (source[key] instanceof Function) {
            target[key] = source[key]
          } else if (! (source[key] instanceof Object)) {
            target[key] = source[key]
          }

          // TODO: Decide if we need a has ownProperty check here?
          copyLeft(target[key], source[key]);
        }
      } else {
        if (source.prototype === undefined || target.prototype === undefined) {
          // Object at first level.
          // Copy over the new keys.
          for (key in source) {
            if (!target.hasOwnProperty(key)) {
              continue;
            }

            if (source[key] instanceof Function) {
              target[key] = source[key]
            } else if (! (source[key] instanceof Object)) {
              target[key] = source[key]
            }

            // Check if is instance and has prototype of its own.
            var sourceProto = Object.getPrototypeOf(source);
            var targetProto = Object.getPrototypeOf(target);
            if (sourceProto && targetProto && sourceProto !== Object.prototype && targetProto !== Object.prototype) {
              //copyLeft(targetProto, sourceProto);

              // Handle prototype and class.

              // Node.js seems to hide the visibility of the class prototypes so need to ask for the names of the properties.
              // We also check their writable status for good measure we we don't want to trigger an exception or something.

              // Get at the "hidden" things in the class prototype.
              newDescriptors = Object.getOwnPropertyDescriptors(sourceProto);
              oldDescriptors = Object.getOwnPropertyDescriptors(targetProto);

              // Overwrite old keys where possible when they exist in new or delete if not exist.
              Object.keys(oldDescriptors).forEach(function(key) {
                if (oldDescriptors.hasOwnProperty(key) && oldDescriptors[key].writable) {
                  // TODO: Handle renamed but 100% same text content?
                  if (newDescriptors.hasOwnProperty(key)) {
                    targetProto[key] = newDescriptors[key].value; // Or maybe source.prototype[key];
                  } else {
                    delete targetProto[key];
                  }
                }
              });

              // Copy new keys if not exist.
              Object.keys(newDescriptors).forEach(function(key) {
                if (newDescriptors.hasOwnProperty(key) && !oldDescriptors.hasOwnProperty(key)) {
                  targetProto[key] = newDescriptors[key].value; // Or maybe source.prototype[key];
                }
              });


            }
            copyLeft(target[key], source[key]);
          }
        } else {
          // Handle prototype and class.

          // Node.js seems to hide the visibility of the class prototypes so need to ask for the names of the properties.
          // We also check their writable status for good measure we we don't want to trigger an exception or something.

          // Get at the "hidden" things in the class prototype.
          newDescriptors = Object.getOwnPropertyDescriptors(source.prototype);
          oldDescriptors = Object.getOwnPropertyDescriptors(target.prototype);

          // Overwrite old keys where possible when they exist in new or delete if not exist.
          Object.keys(oldDescriptors).forEach(function(key) {
            if (oldDescriptors.hasOwnProperty(key) && oldDescriptors[key].writable) {
              // TODO: Handle renamed but 100% same text content?
              if (newDescriptors.hasOwnProperty(key)) {
                target.prototype[key] = newDescriptors[key].value; // Or maybe source.prototype[key];
              } else {
                delete target.prototype[key];
              }
            }
          });

          // Copy new keys if not exist.
          Object.keys(newDescriptors).forEach(function(key) {
            if (newDescriptors.hasOwnProperty(key) && !oldDescriptors.hasOwnProperty(key)) {
              target.prototype[key] = newDescriptors[key].value; // Or maybe source.prototype[key];
            }
          });
        }
      }
    } else {
      // What to do if not an object?
      /* TODO: Handle things like
        var a = Object.create(null);
        a.test = 1;
        // a instanceof Object would result to false but there are still keys.
      */
    }

  }

  function reload(modulePath, src) {
    var oldExports;
    var resolvedModulePath = path.resolve(modulePath);

    // Don't reload main module/script.
    if (resolvedModulePath === process.mainModule.filename) {
      emitter.emit('not-reloaded', modulePath);
      return;
    }

    // State object used for store & restore functionality.
    var state = {};

    try {
      // TODO: first attempt a custom resolver.
      if (!path.isAbsolute(resolvedModulePath)) {
      resolvedModulePath = Module._resolveFilename(modulePath, this);
      }

      // Only reload if its in cache already.
      if (graph.hasNode(resolvedModulePath)) {

        // Delete it from the cache because we want to re-load the code.
        delete require.cache[resolvedModulePath];

        if (src === undefined) {
          src = fs.readFileSync(modulePath, 'utf8');
        }

        var newExports;
        var isJSON = path.extname(modulePath) === '.json';
        if (isJSON) {
          newExports = JSON.parse(src);
        } else {
          newExports = requireFromString(src, modulePath, {
            parent: this
          });
        }

        //var newExports = __require.call(Module, resolvedModulePath);
        oldExports = graph.getNodeData(resolvedModulePath);

        if (oldExports && oldExports.hot && oldExports.hot.store) {
          oldExports.hot.store(state);
        }

        if (newExports) {

          // TODO: Move this higher up, delete the functions if they are deleted from newExports
          var backupHot = oldExports.hot;

          // Copy over old cache values for prototypes and other keys/properties.
          copyLeft(oldExports, newExports);

          // Restore the hot object / functions if it was deleted.
          if (backupHot && !oldExports.hot) {
            oldExports.hot = backupHot;
          } else if (backupHot && oldExports.hot) {
            if (backupHot.store && !oldExports.hot.store) {
              oldExports.hot.store = backupHot.store;
            }
            if (backupHot.restore && !oldExports.hot.restore) {
              oldExports.hot.restore = backupHot.restore;
            }
          }

          // Run the old exports restore if present.
          if (oldExports && oldExports.hot && oldExports.hot.restore) {
              oldExports.hot.restore(state);
            }
        }

        emitter.emit('loaded', modulePath, newExports);
        emitter.emit('reloaded', modulePath, newExports);
      } else {
        emitter.emit('not-reloaded', modulePath);
      }
    } catch (e) {
      emitter.emit('not-reloaded', modulePath);
      // Restore the old cache?
      if (oldExports) {
        require.cache[resolvedModulePath] = oldExports;

        // Run the old exports hot restore if present.
        if (oldExports && oldExports.hot && oldExports.hot.store) {
          oldExports.hot.restore(state);
        }
      }
      emitter.emit('error', {
        path: modulePath,
        error: e
      });
    }
  }

  // Expose this method just in-case it is wanted.
  emitter.reload = reload;

  selfCache = emitter;

  // Return our emitter so that user code may listen for events.
  return emitter;
};