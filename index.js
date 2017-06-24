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
//   1) Data might be wrong / not existant on old objects for when running new code.
//   2) Sync loading at runtime is not so good. (We don't care its to facilitate rapid development).
//   3) Infinite loop posibility if code would write to an already watched file during its require step.
//      Require cycle would never complete / error application when it maxs stack.
//      (Well the solution is simple here, don't overwrite those files from code during load...)
//   4) Deleting code or files could have unexpected results, code/modules still in use. (Again we don't care about that).
//   5) Restarting the server may be nessecary at some points to get a clean state on all data.
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
// But we have not yet fully commited to that idea, although it would proabbly be better for scaling.
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
const EventEmitter = require('events');
// Note: Using chokidar for its cross platform support. I wonder if it is overkill though, but it does get the job done.
const chokidar = require('chokidar');
const path = require('path');

const debug = require('debug')('hotter-require');
const Module = require('module');
const DepGraph = require('dependency-graph').DepGraph;

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
    }
  }

  class HotReloadEmitter extends EventEmitter {};
  const emitter = new HotReloadEmitter();
  const watcher = chokidar.watch(['**.js', '**.json'], {
    persistent: options.persistent,
    ignoreInitial: true,
    ignored: /(node_modules)/,
    awaitWriteFinish: options.awaitWriteFinish
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
  });

  // This code modified from code by Kenneth Chung.
  const graph = new DepGraph();
  const __require = Module.prototype.require;

  Module.prototype.require = function(modulePath) {
    var resolvedModulePath = Module._resolveFilename(modulePath, this);

    // A work around because weirdly sometimes the module is not in the cache straight away?
    var requiredModule = __require.call(this, modulePath);

    // Note: Using dependency graph because each module has its own require cache but we want a shared one.
    if (!graph.hasNode(resolvedModulePath)) {
      emitter.emit('loaded', modulePath);
    }

    graph.addNode(this.filename);
    graph.addNode(resolvedModulePath, requiredModule);
    graph.addDependency(this.filename, resolvedModulePath);

    return requiredModule;
  };

  function copyLeft(target, source) {
    // TODO: Object properties with getters and setters??
    // Handle both functions with prototypes.
    if (target.prototype && source.prototype) {
      copyLeft(target.prototype, source.prototype);
    }

    for (var key in source) {
      target[key] = source[key];

      // Handle functions with prototypes exported.
      if (target[key].prototype && source[key].prototype) {
        copyLeft(target[key].prototype, source[key].prototype);
      }
    }
    for (var key in target) {
      if (source[key] === undefined) {
        delete target[key];
      }
    }
  }

  function reload(modulePath) {
    var oldExports;
    try {
      var resolvedModulePath = Module._resolveFilename('./' + modulePath, this);
      // Only reload if its in cache already.
      if (graph.hasNode(resolvedModulePath)) {

        // Delete it from the cache because we want to re-load the code.
        delete require.cache[resolvedModulePath];
        var newExports = __require(resolvedModulePath);
        oldExports = graph.getNodeData(resolvedModulePath);

        var state = {};
        if (oldExports && oldExports.hot && oldExports.hot.store) {
          oldExports.hot.store(state);
        }
        if (newExports.hot && newExports.hot.restore) {
          newExports.hot.restore(state);
        }

        if (newExports) {
          // Copy over old cache values for prototypes and other keys/properties.
          copyLeft(oldExports, newExports);
        }

        emitter.emit('loaded', modulePath);
        emitter.emit('reloaded', modulePath);
      }
    } catch (e) {
      // Restore the old cache?
      if (oldExports) {
        require.cache[resolvedModulePath] = oldExports;
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
}