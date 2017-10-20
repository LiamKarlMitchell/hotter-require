# hotter-require
Modifies require to enable hot-reloading of code modules.

Updates prototypes and other keys on old cache so that old objects would use new methods.
Complains about errors but will retain the previous require cache. Handles dependencies, json and an option to retain state between reloads. Emits when a file has been re-required successfully so your application might do some logic based on that.


File system is watched by Chokidar for changes in js and json files.
Files matching name of /node_modules/ and /.git/ are ignored.

# usage

Most simple usage, simply include this in your entry js file before other requires.

```js
var hotter = require('hotter-require')();
```


Do some special handling with a file change notification.

```js
hotter.on('change', function(filePath) {
    console.log('CHANGE: '+filePath);
});

Listen and do something with errors?

```js
hotter.on('error', function(error) {
    console.error(error);
});
```

Any chokidar emiters work here.

If you want to you can disable the watcher on init.

```js
var hotter = require('hotter-require')({ noWatch: true });
```

Or disable the watcher at runtime.

```js
hotter.stopWatching();
```

Start watching if it was previously disabled.

```js
hotter.startWatching();
```


Manually reload a module path. (Useful it not using watcher).
```js
hotter.reload(modulePath);
```

Other event emitter labels.
post-change
not-loaded

Change event emitter can be used to reject a reload.
Check the path, if it matches your critera to ignore, set the 2nd arguments ignore value to true.

```js
hotter.on('change', function(modulePath, feedback){
    if (modulePath.indexOf('_noreload')>-1) {
        feedback.ignore = true;
    }
})
```

Want to watch your parent directory's changes?
How about watching another file type as well but only in one tree of directory?

No problem.
```js
hotter.watcher.unwatch('**/*.(js|json)');
hotter.watcher.add('../**/*.(js|json)');
hotter.watcher.add('../structures/**/*.h');
```


Note: I intend to add in functionality to load from data/text passed in as the 2nd parameter rather than from disk.
      But this does involve writing my own require functionality, currently I just wrap normal function.
      An issue has been made for this. [#8](/issues/8)