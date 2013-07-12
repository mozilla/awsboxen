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

  // Hash of parameter definitions.
  // These may be specified as a single "key=value,key=value" string,
  // or as a list of such strings.  Eventually we might read them from
  // config files as well.
  opts.define = {};
  var define = getOption('define', options);
  if (define) {
    if (typeof define !== 'object') {
      define = [define];
    }
    define.forEach(function(definition) {
      definition.split(',').forEach(function(definition) {
        var bits = definition.split('=');
        opts.define[bits[0]] = bits.slice(1).join('=');
      });
    });
  }

  return cb(null, opts);
}
