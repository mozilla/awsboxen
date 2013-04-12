#!/usr/bin/env node
//
// Command-line `awsboxen` client.
//
// This module implements the CLI for awsboxen, but it's also importable as
// a standard module if you want to do something strange on top of it.  Most
// functionality is implemented in other, more API-focussed modules to which
// this is simply a wrapper.
//

const async = require('async');
const docopt = require('docopt');

const config = require('./config');
const projinfo = require('./projinfo');
const freezer = require('./freezer');
const cfn = require('./cfn');

// Our command-line options.
// This becomes a working parser by the magic od docopt.
// Ye Gods, there must be a better way to do multi-line strings in JS...
//
const USAGE = ''+
'awsboxen\n'+
'\n'+
'Usage:\n'+
'  awsboxen deploy [--profile=PROFILE] <name>\n'+
'  awsboxen list [--profile=PROFILE]\n'+
'  awsboxen info <name>\n'+
'  awsboxen teardown <name>\n'+
'  awsboxen showconfig [--profile=PROFILE]\n'+
'  awsboxen freeze [--profile=PROFILE] [<box>...]\n'+
'\n'+
'Arguments:\n'+
'  <name>:  a unique name used to name identify this deployment\n'+
'  <box>:   name of a Boxen declaration to freeze; defaults to all boxen\n'+
'\n'+
'Options:\n'+
' -h --help                         show this help message and exit\n'+
' -p PROFILE --profile=PROFILE      name of the deployment profile to use\n'+
'\n';


// The individual sub-commands that can be run through the CLI.
//
module.exports.commands = {

  showconfig: function showconfig(opts, cb) {
    projinfo('.', opts.profile).loadConfig(function(err, cfg) {
      if (err) return cb(err);
      // Generate stub parameters for each boxen AMI.
      async.eachSeries(Object.keys(cfg.Boxen), function(boxName, cb) {
        cfg.Parameters[boxName + 'AMI'] = {
          Type: 'String',
          Default: 'ami-XXXXXX'
        };
        cb(null);
      }, function(err) {
          if (err) return cb(err);
          console.log(JSON.stringify(cfg, null, 2));
          cb(null);
      });
    });
  },
 
  deploy: function deploy(opts, cb) {
    async.waterfall([
      // Load the selected configuration.
      function loadTheConfig(cb) {
        projinfo('.', opts.profile).loadConfig(cb);
      },
      // Generate AMIs for each box description.
      // The AMI id becomes a cfn template paramter.
      function generateBoxenAMIs(cfg, cb) {
        async.eachSeries(Object.keys(cfg.Boxen), function(boxName, cb) {
          var boxCfg = cfg.Boxen[boxName];
          freezer.createAwsBoxAMI(opts, '.', boxName, boxCfg, function(e, id) {
            if (e) return cb(e);
            cfg.Parameters[boxName + 'AMI'] = {
              Type: 'String',
              Default: id
            };
            cb(null);
          });
        }, function(err) {
          delete cfg.Boxen;
          cb(err, cfg);
        });
      },
      // XXX TODO: somehow read parameters from the user.
      function readExtraParams(cfg, cb) {
        cb(null, cfg);
      },
      // Deploy the completed CloudFormation template.
      function deployTheStack(cfg, cb) {
        cfn.deployStack(opts, cfg, function(err, stack) {
          if (err) return cb(err);
          console.log('Stack "' + stack.name + '" successfully deployed!');
          cb(null);
        });
      }
    ], cb);
  },

  list: function list(opts, cb) {
    // XXX TODO: filtering by profile
    cfn.listStacks(opts, function(err, stackNames) {
      if (err) return cb(err);
      stackNames.forEach(function(name) {
        console.log(name);
      });
      cb(null);
    });
  },

  info: function list(opts, cb) {
    cfn.checkStack(opts, function(err, stack) {
      if (err) return cb(err);
      if (!stack) return cb('no such stack: "' + opts.name + '"');
      for(var k in stack) {
        if(stack.hasOwnProperty(k)) {
          console.log(k + ':  ' + stack[k]);
        }
      }
      cb(null);
    });
  },

  teardown: function list(opts, cb) {
    cfn.teardownStack(opts, function(err) {
      return cb(err);
    });
  },


  freeze: function freeze(opts, cb) {
    projinfo('.', opts.profile).loadConfig(function(err, cfg) {
      if (err) return cb(err);
      // Freeze the specified boxen, or all if none were specified.
      if (opts.box.length === 0) {
        opts.box = Object.keys(cfg.Boxen);
      } else {
        for (var i=0; i < opts.box.length; i++) {
          if (!cfg.Boxen[opts.box[i]]) {
            return cb('unknown Box: ' + opts.box[i]);
          }
        }
      }
      // Create all the AMIs, collecting their ids for later reporting.
      // This generates a lot of console output, so we don't want to
      // print the final ids in the middle of it where they'll get lost.
      var amiIds = {};
      async.eachSeries(opts.box, function(boxName, cb) {
        var boxCfg = cfg.Boxen[boxName];
        freezer.createAwsBoxAMI(opts, '.', boxName, boxCfg, function(err, id) {
          if (err) return cb(err);
          amiIds[boxName] = id;
          return cb(null);
        });
      }, function(err) {
        if (err) return cb(err);
        // Now we can print the list of AMI ids.
        console.log("Successfully generated AMIs for your frozen boxen:");
        async.eachSeries(opts.box, function(boxName, cb) {
          console.log('  ' + boxName + ': ' + amiIds[boxName]);
          cb(null);
        }, cb);
      });
    });
  }

};


module.exports.main = function main(argv, cb) {
  // Parse command-line arguments.
  // XXX TODO: stop it from exiting the program itself.
  var options = docopt.docopt(USAGE, {argv: argv});

  // Gather command-line options and arguments into a dict,
  // without all the docopt formatting cruft.
  var command = null;
  var commandOptions = {};
  for (var k in options) {
    if (options.hasOwnProperty(k)) {
      var match = /(<([A-Za-z0-0]+)>)|(--([A-Za-z0-9]+))/.exec(k);
      if (!match) {
        if (options[k]) {
          command = k;
        }
      } else {
        var name = match[2] || match[4];
        if (name && name !== 'help') {
          commandOptions[name] = options[k];
        }
      }
    }
  }

  // That should have produced a usable command name.
  // Error out if not.
  if (!command) {
    console.log('Error processing options!');
    return cb(1);
  }

  // Now we can run the command.
  module.exports.commands[command](commandOptions, function(err) {
    if (err) {
      console.error(err);
      return cb(1);
    }
    return cb(0);
  });
};


// Make this executable as a script, but also importable as a module.
//
if (require.main === module) {
  process.title = 'awsboxen';
  module.exports.main(process.argv.slice(2), function(code) {
    process.exit(code);
  });
}
