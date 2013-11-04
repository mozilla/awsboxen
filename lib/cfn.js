/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * A high-level wrapper over the CloudFormation web api.
 *
 * The functions implemented in this module correspond roughly to the
 * high-level actions that can be taken through the command-line interface,
 * e.g. "deploy a stack" or "list all stack names".
 *
 */

const async = require('async');
const aws = require('awssum-amazon');
const CloudFormation = require('awssum-amazon-cloudformation').CloudFormation;


const SUCCESS_STATUSES = ['CREATE_COMPLETE', 'DELETE_COMPLETE',
                          'UPDATE_COMPLETE'];
const FAILURE_STATUSES = ['CREATE_FAILED', 'ROLLBACK_FAILED',
                          'ROLLBACK_COMPLETE', 'DELETE_FAILED',
                          'UPDATE_ROLLBACK_FAILED',
                          'UPDATE_ROLLBACK_COMPLETE'];
const INFLIGHT_STATUSES = ['CREATE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS',
                           'DELETE_IN_PROGRESS', 'UPDATE_IN_PROGRESS',
                           'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
                           'UPDATE_ROLLBACK_IN_PROGRESS',
                           'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS'];


module.exports = {
  checkStack: checkStack,
  waitForStack: waitForStack,
  getStackEvents: getStackEvents,
  deployStack: deployStack,
  validateTemplate: validateTemplate,
  listStacks: listStacks,
  teardownStack: teardownStack,
  getResourceInfo: getResourceInfo
};


//  Get a connection to the CloudFormation API.
//  Use parameters from the given options hash.
//
function getConnection(opts, cb) {
  var cfn = null;
  var err = null;
  try {
    cfn = new CloudFormation({
      accessKeyId: opts.aws_id,
      secretAccessKey: opts.aws_secret,
      region: opts.aws_region
    });
  } catch (e) { err = e; }
  cb(err, cfn);
}


//  Check the status of a deployed stack.
//  The given options must include a 'stack_name' key naming the stack.
//  The result is either null if there is no such stack, or an object
//  with whichever of the following keys are currently known:
//
//    * status:  the status string for the stack
//    * AWSBoxenProfile:  the name of the deployed profile
//    * AWSBoxenCommit:  git commit id of the deployed code
//    * any CloudFormation outputs you have defined
//
//
function checkStack(opts, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.DescribeStacks({ StackName: opts.stack_name }, function(err, res) {
      // An error response might indicate that the stack doesn't exist,
      // or that something more serious has gone wrong.
      if (err) {
        if (err.Body && err.Body.ErrorResponse) {
          var msg = err.Body.ErrorResponse.Error.Message;
          if (msg === 'Stack:' + opts.stack_name + ' does not exist') {
            return cb(null, null);
          }
        }
        return cb(extractError(err)); 
      }
      // Now we can safely grab info out of the stack description.
      res = res.Body.DescribeStacksResponse.DescribeStacksResult.Stacks.member;
      var stack = {
        name: res.StackName,
        status: res.StackStatus,
      };
      if (res.Outputs && res.Outputs.member) {
        if (typeof res.Outputs.member.forEach !== 'function') {
          res.Outputs.member = [res.Outputs.member];
        }
        res.Outputs.member.forEach(function(item) {
          stack[item.OutputKey] = item.OutputValue;
        });
      }
      cb(null, stack);
    });
  });
}


//  Get events associated with the stack.
//
//  The given options must include a 'stack_name' key naming the stack.
//  They may optionally include a 'last_stack_event' key giving the
//  EventId of the last-seen stack event.  Events will only be returned
//  if they occurred after that event.
//
//  The result is an array of StackEvent info hashes, with the most recent
//  event first.
//
function getStackEvents(opts, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    var args = {
      StackName: opts.stack_name
    };
    cfn.DescribeStackEvents(args, function(err, res) {
      if (err) return cb(extractError(err));
      var events = res.Body.DescribeStackEventsResponse;
      events = events.DescribeStackEventsResult.StackEvents.member;
      if (opts.last_stack_event) {
        for (var i=0; i < events.length; i++) {
          if (events[i].EventId === opts.last_stack_event) {
            events = events.slice(0, i);
            break;
          }
        }
      }
      return cb(null, events);
    });
  });
}


//  Wait for a stack to settle into a steady state.
//  Returns the final result of checkStack() once steady state is reached.
//  Logs progress by polling the stack event stream.
//
function waitForStack(opts, cb) {
  var stack = null;
  // Get the list of events as it is before polling.
  // These are pre-existing events, so they're not logged to console.
  getStackEvents(opts, function(err, events) {
    if (err) return cb(err);
    if (events && events.length) {
      opts.last_stack_event = events[0].EventId;
    }
    // Loop while the stack is in an in-flight state.
    async.doWhilst(function(cb) {
      setTimeout(function() {
        // Look for new events, log them to the console.
        getStackEvents(opts, function(err, events) {
          if (err) return cb(err);
          if (events && events.length) {
            for (var i=events.length - 1; i >= 0; i--) {
              var msg = events[i].StackName + ": ";
              msg += events[i].LogicalResourceId + ": ";
              msg += events[i].ResourceStatus;
              if (events[i].ResourceStatusReason) {
                msg += " [" + events[i].ResourceStatusReason + "]";
              }
              console.log(msg);
            }
            opts.last_stack_event = events[0].EventId;
          }
          // Fetch updated status for the stack.
          checkStack(opts, function(err, res) {
            stack = res;
            cb(err);
          });
        });
      }, 500);
    }, function() {
      return stack && INFLIGHT_STATUSES.indexOf(stack.status) !== -1;
    }, function(err) {
      if (stack) {
        console.log(opts.stack_name + ': ' + stack.status);
      }
      return cb(err, stack);
    });
  });
}


//  Deploy a CloudFormation stack.
//  The given options must include a 'stack_name' key naming the stack.
//  This will create the stack if it doesn't exist, and update it otherwise.
//
function deployStack(opts, cfg, cb) {
  // Process parameter definitions into bizarro syntax for submission.
  var params = {};
  var paramNum = 1;
  Object.keys(opts.define || {}).forEach(function(key) {
    params["member." + paramNum + ".ParameterKey"] = key;
    params["member." + paramNum + ".ParameterValue"] = opts.define[key];
    paramNum++;
  });
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    checkStack(opts, function(err, stack) {
      if (err) return cb(err);
      // Should we create a new stack, or update an existing one?
      var action, successStatus;
      if (!stack) {
        action = function() { cfn.CreateStack.apply(cfn, arguments); };
        successStatus = 'CREATE_COMPLETE';
      } else {
        action = function() { cfn.UpdateStack.apply(cfn, arguments); };
        successStatus = 'UPDATE_COMPLETE';
      }
      action({
        StackName: opts.stack_name,
        TemplateBody: JSON.stringify(cfg),
        Parameters: params
      }, function(err) {
        // An error is reported if the config hasn't changed since last deploy.
        // We don't want to propagate that one to the client.
        if (err) {
          if (err.Body && err.Body.ErrorResponse) {
            var msg = err.Body.ErrorResponse.Error.Message;
            if (msg === 'No updates are to be performed.') {
              return cb(null, stack);
            }
          }
          return cb(extractError(err)); 
        }
        waitForStack(opts, function(err, stack) {
          if (err) return cb(err);
          if (!stack) return cb('CREATE_FAILED');
          if (stack.status !== successStatus) return cb(stack.status);
          cb(null, stack);
        });
      });
    });
  });
}


// Extract a useful error object.
// This peeks inside the awssum error response to return the actual body,
// but passes other error objects through unchanged.
//
function extractError(err) {
  if (!err) return err;
  if (!err.Body) return err;
  return err.Body;
}


//  Validate a CloudFormation stack template.
//
function validateTemplate(opts, cfg, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.ValidateTemplate({
      TemplateBody: JSON.stringify(cfg),
    }, function(err) {
      if (err) return cb(extractError(err));
      return cb(null);
    });
  });
}


// List all the currently available stacks.
//
function listStacks(opts, cb) {
  // XXX TODO: implement handling of NextToken pagination thing.
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.ListStacks({}, function(err, res) {
      if (err) return cb(extractError(err)); 
      res = res.Body.ListStacksResponse.ListStacksResult.StackSummaries.member;
      var stackNames = [];
      if (res) {
        res.forEach(function(stack) {
          if (stack.StackStatus !== 'DELETE_COMPLETE') {
            stackNames.push(stack.StackName);
          }
        });
      }
      cb(null, stackNames);
    });
  });
}


//  Completely tear down a stack.
//
function teardownStack(opts, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.DeleteStack({ StackName: opts.stack_name }, function(err) {
      if (err) return cb(extractError(err)); 
      waitForStack(opts, function(err, stack) {
        if (err) return cb(err);
        if (!stack) return cb(null);
        if (stack.status !== 'DELETE_COMPLETE') return cb(stack.status);
        cb(null);
      });
    });
  });
}


//  Get info about a particular resource in the stack.
//
//  The name of the resource should be given as opts.resource_name.  If
//  it is falsy, then info about the stack itself will be returned.
//
function getResourceInfo(opts, cb) {
  if (!opts.resource_name) {
    return checkStack(opts, cb);
  }
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    var args = {
      StackName: opts.stack_name,
      LogicalResourceId: opts.resource_name
    };
    cfn.DescribeStackResource(args, function(err, res) {
      if (err) return cb(extractError(err)); 
      res = res.Body.DescribeStackResourceResponse;
      res = res.DescribeStackResourceResult.StackResourceDetail;
      var info = {};
      info.name = res.LogicalResourceId;
      info.type = res.ResourceType;
      info.id = res.PhysicalResourceId;
      info.modified = res.LastUpdatedTimestamp;
      if (getExtraInfo[info.type]) {
        return getExtraInfo[info.type](opts, info, cb);
      } else {
        return cb(null, info);
      }
    });
  });
}


//  Functions to get extra type-specific information about a stack resource.
//  XXX TODO: add lots more resource types here.
//
var getExtraInfo = {
  'AWS::ElasticLoadBalancing::LoadBalancer': require('./stackinfo/elb.js'),
  'AWS::EC2::Instance': require('./stackinfo/instance.js')
};
