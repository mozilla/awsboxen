/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Option-processing logic for awsboxen.
 *
 * This module implements the bulk of the command-line and environment option
 * parsing for awsboxen.  Call it with an options hash and optionally an
 * environment hash.  It will normalize the given data and return a (new)
 * options hash with the following keys:
 *
 *    XXX TODO specify the keys
 *
 * Many other functions in awsboxen expect to be given this normalized options
 * has as their first argument.
 *
 */

const fs = require('fs');
const async = require('async');
const child_process = require('child_process');


module.exports = {
  getOptions: getOptions
};


//  Get the value of the named option, looking via several common
//  forms in the command-line arguments hash.
//
function getOption(name, options) {
  // It might be given as options[option_name]
  if (options.hasOwnProperty(name)) {
    return options[name];
  }
  // It might be given as options[--option-name]
  var nameWithUnderscores = name.replace(/_/g, '-');
  var mangledName = '--' + nameWithUnderscores;
  if (options.hasOwnProperty(mangledName)) {
    return options[mangledName];
  }
  // It might be given as options[<option-name>]
  mangledName = '<' + nameWithUnderscores + '>';
  if (options.hasOwnProperty(mangledName)) {
    return options[mangledName];
  }
  // Nope, it's not specified.
  return undefined;
}


//  Get the options hash, accounting for command line, environ, and defaults.
//  This function is asyncronous, since it might read parameter files.  If
//  the parameter files are encrypted then it will spawn gpg to decrypt
//  them, which might wind up doing some console I/O.  You've been warned!
//
function getOptions(options, environ, cb) {

  if (typeof cb === 'undefined') {
    cb = environ;
    environ = null;
  }
  if (!environ) {
    environ = process.env;
  }

  var opts = {};

  // The AWS access key id.
  opts.aws_id = getOption('aws_id', options);
  if (!opts.aws_id) {
    opts.aws_id = environ.AWS_ID;
    if (!opts.aws_id) {
      return cb('could not determine AWS_ID');
    }
  }

  // The AWS secret access key.
  opts.aws_secret = getOption('aws_secret', options);
  if (!opts.aws_secret) {
    opts.aws_secret = environ.AWS_SECRET;
    if (!opts.aws_secret) {
      return cb('could not determine AWS_SECRET');
    }
  }

  // The AWS region for the deployment.
  opts.aws_region = getOption('aws_region', options);
  if (!opts.aws_region) {
    opts.aws_region = environ.AWS_REGION;
    if (!opts.aws_region) {
      opts.aws_region = 'us-east-1';
    }
  }

  // The name of the profile to use.
  opts.profile = getOption('profile', options);
  if (!opts.profile) {
    opts.profile = 'Default';
  }

  // The name under which to deploy the stack.
  opts.stack_name = getOption('stack_name', options);
  if (!opts.stack_name) {
    opts.stack_name = '';
  }

  // The list of boxen names to freeze.
  opts.boxen = getOption('boxen', options);
  if (typeof opts.boxen === 'string') {
    opts.boxen = [opts.boxen];
  }

  // Whether to ignore uncommitted changes in the repository.
  opts.ignore_uncommitted = getOption('ignore_uncommitted', options) || false;

  // Whether to load from specific config files, or the default files.
  opts.config = getOption('config', options) || [];
  if (typeof opts.config === 'string') {
    opts.config = [opts.config];
  }

  // Hash of parameter definitions.
  //
  // These may be specified as a single "key=value,key=value" string,
  // or as a list of such strings.  They might also come from config files
  // which might need to be decrypted on the fly.
  opts.define = {};
  var paramFiles = getOption('param_file', options) || [];
  if (typeof paramFiles === 'string') {
    paramFiles = [paramFiles];
  }
  async.eachSeries(paramFiles, function(paramFile, cb) {
    async.eachSeries(paramFile.split(','), function(paramFile, cb) {
      async.waterfall([
        // Load data from the file, possibly decrypting it.
        function(cb) {
          fs.readFile(paramFile, function(err, data) {
            if (err) return cb(err);
            data = data.toString();
            if (data.indexOf('-----BEGIN PGP') !== 0) {
              return cb(null, data);
            } else {
              decryptFile(paramFile, function(err, data) {
                if (err) return cb(err);
                return cb(null, data);
              });
            }
          });
        },
        // Parse JSON and merge it into the options hash.
        function(data, cb) {
          try {
            data = JSON.parse(data);
          } catch (err) {
            return cb(err);
          }
          for (var k in data) {
            if (data.hasOwnProperty(k)) {
              opts.define[k] = data[k];
            }
          }
          return cb(null);
        }
      ], cb);
    }, cb);
  },

  // Done.  Merge with command-line definitions, then the opts.
  function(err) {
    if (err) return cb(err);
    // Overwrite with any command-line definitions.
    var defines = getOption('define', options) || [];
    if (typeof defines !== 'object') {
      defines = [defines];
    }
    defines.forEach(function(definition) {
      definition.split(',').forEach(function(definition) {
        var bits = definition.split('=');
        opts.define[bits[0]] = bits.slice(1).join('=');
      });
    });
    return cb(null, opts);
  });
}


// Spawn gpg as a subprocess, to decrypt a file.
//
function decryptFile(filepath, cb) {
  var cmd = 'gpg';
  var args = ['--decrypt', filepath];
  var opts = { stdio: [0, 'pipe', 2] };
  var p = child_process.spawn(cmd, args, opts);
  var output = '';
  p.stdout.on('data', function(data) {
    output += data;
  });
  p.on('error', function(err) {
    return cb(err);
  });
  p.on('exit', function(code, signal) {
    if (code || signal) return cb('gpg failed');
    return cb(null, output);
  }); 
}
