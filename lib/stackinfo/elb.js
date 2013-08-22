/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const async = require('async');
const aws = require('awssum-amazon');
const Elb = require('awssum-amazon-elb').Elb;
const instance_getExtraInfo = require('./instance.js');

module.exports = function getExtraInfo(opts, info, cb) {
  var elb;
  try {
    elb = new Elb({
      accessKeyId: opts.aws_id,
      secretAccessKey: opts.aws_secret,
      region: opts.aws_region
    });
  } catch (e) { return cb(e); }
  elb.DescribeLoadBalancers({
    LoadBalancerNames: [info.id]
  }, function(err, res) {
    if (err) return cb(err);
    res = res.Body.DescribeLoadBalancersResponse.DescribeLoadBalancersResult;
    res = res.LoadBalancerDescriptions.member;
    info.dnsname = res.DNSName;
    info.instances = {};
    var instances = res.Instances.member;
    if (typeof instances.length === "undefined") instances = [instances];
    async.eachSeries(instances, function(instance, cb) {
      var instanceInfo = {"id": instance.InstanceId};
      // XXX TODO: we could query info for all instances at once.
      instance_getExtraInfo(opts, instanceInfo, function(err) {
        if (err) return cb(err);
        delete instanceInfo.id;
        info.instances[instance.InstanceId] = instanceInfo;
        return cb(null);
      });
    }, function(err) {
      if (err) return cb(err);
      return cb(null, info);
    });
  });
};
