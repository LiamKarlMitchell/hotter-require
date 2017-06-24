var fs = require('fs');

fs.unlink('./MyModule.js', function() {

  var hotter = require('../../hotter-require')();

  hotter.on('ready', start);

  // hotter.on('loaded', function(modulePath){
  //   console.log('Loaded: '+modulePath);
  // });

  // hotter.on('change', function(filePath) {
  //   console.log('CHANGE: '+filePath);
  // });

  hotter.on('error', function(error) {
    console.error(error);
  });


  var myModule;
  var stepIndex = 0;

  function step() {
    switch (stepIndex++) {
      case 0:
        var MyModule = require('./MyModule');

        myModule = new MyModule();

        hotter.on('loaded', function(filePath) {
          if (filePath === "MyModule.js") {
            console.log('MyModule.js has been loaded.');
            step();
          }
        });

        // Output the test value 1.
        console.log(myModule.test() + " from MyModule prototype method.");

        // Wait some time becahse the watcher does not fire multiple times for very rapid writes.
        setTimeout(function() {
          console.log('Writing version 2 MyModule.js');
          fs.writeFile("./MyModule.js", `
        function MyModule() {

        }

        var VERSION = 2;
        MyModule.prototype.test = function(){
          return "Ver: "+VERSION;
        }

        module.exports = MyModule;
      `, function() {
            console.log('MyModule.js version 2 written to disk.')
          });
        }, 500);
        break;
      case 1:
        console.log(myModule.test() + " from MyModule prototype method.");
        cleanup();
        break;
    }
  }



  function start() {
    console.log('Starting test');
    // Ensure version 1 file is there.
    console.log('Writing version 1 MyModule.js');
    fs.writeFile("./MyModule.js", `
    function MyModule() {

    }

    var VERSION = 1;
    MyModule.prototype.test = function(){
      return "Version: "+VERSION;
    }

    module.exports = MyModule;
  `, step);
  }


  function cleanup() {
    fs.unlink('./MyModule.js', function() {
      console.log('Deleted MyModule.js');
      console.log('Finished test');
    });
  }

});