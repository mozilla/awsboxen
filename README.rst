Deploy and Scale NodeJS Applications in AWS
===========================================

This is an experiment in automating deployment and scaling of NodeJS
applications.  It lets you declare the structure of your deployment right
next to your app and instantly push it into the cloud, as anything from a
single server through to a highly complex cluster.

It uses Amazon Web Services for hosting, Amazon CloudFormation to describe
a deployment, and awsbox for all the fiddly NodeJS deployment bits:

  * http://awsbox.org/
  * http://aws.amazon.com/cloudformation/

You might like to think of it as "awsbox on steroids".
Legal, harmful-side-effect-free steroids.


Quickstart
----------

The awsboxen process in a nutshell:

  0)  Store your code in git.  We assume you're working from a git checkout.
  1)  Create a ".awsboxen.json" file at the top level of your project.
  2)  Populate it with awsbox and CloudFormation configuration data
  3)  Run "awsboxen deploy".
  4)  Relax as your app is effortlessly deployed to the cloud.


The ".awsboxen.json" document describes the entire structure of the deployment.
It includes awsbox config to specify the code and processes that should be run,
and CloudFormation config to specify the physical resources on which to run
them.


Managing a Deployment
---------------------

All deployment managment is done through the "awsboxen" command-line client.
Here are the major modes of operation:


**awsboxen deploy [--profile=PROFILE] [--define=PARAM=VALUE,...] <name>**

This command lets you deploy a new version of your code into the cloud.  You
specify an optional deployment profile, and a unique name for this particular
deployment.

This command will:

  * Parse and load the .awsboxen.json file from the current directory.
  * Find all the declared boxen, and use awsbox to create an AMI for each
    with the appropriate version of the code.
  * Serialize the CloudFormation description and pass it up to AWS to
    create or update the deployment.
  * Wait until the deployment has completed, and report success or failure.

The same command works for creating a new deployment and updating an exsiting
deployment to a new code version.  Amazon CloudFormation has strong support
for making safe updates to an existing deployment, as described here:

  http://aws.amazon.com/about-aws/whats-new/2011/09/29/aws-cloudformation-new-features-update-stack-and-iam-support/

This approach allows you to version-control your evolving deployment stack
right alongside the actual code.  New version adds another type of server,
opens new network ports, and increases the size of the database?  No problem,
CloudFormation will take care of it with as little downtime as possible.
Want a staged rollout of new instances to your auto-scaling group?  No problem,
CloudFormation can do that for you.


**awsboxen freeze [--profile=PROFILE] [<box>...]**

Generate the frozen awsbox AMIs for all declared boxen, or for just the boxen
named on the command-line.  This may be useful if you want to use awsboxen
for development, then plug the AMIs into some other system for final production
deployent.


**awsboxen showconfig [--profile=PROFILE]**

This command will print the CloudFormation configuration as would be sent
up to AWS, along with the processed list of Boxen definitions.  It's very
useful for debugging our configuration.


**awsboxen list**

This command will list the name of all current deployment stacks.


**awsboxen info <name>**

This command gets information about a current deployment stack, including:

  * status of the stack
  * any "outputs" declared in the CloudFormation config
  * eventually this will report the deployed version of the code


**awsboxen teardown <name>**

This command destroys a deployment stack, deallocating all the corresponding
AWS resources.  It's very highly descructive and cannot be undone, so due
care should be taken!


AWS Access Credentials
----------------------

To access CloudFormation you will need to specify an AWS access key id and
matching secret key.  These can be provided in the command-line with the
`--aws-id` and `--aws-secret` options, or in the environment variables
`$AWS_ID` and `$AWS_SECRET`.

The deployment region can also be specified with either `--aws-region` or
`$AWS_REGION`.  It defaults to us-east-1.


Describing a Deployment
-----------------------

The structure of your AWS deployment is described using the AWS CloudFormation
language, with some shortcuts and helpers to make things a little more
convenient.

Conceptually, you provide a file ".awsboxen.json" with a full description
of the desired deployment structure - all machine images, load balancers,
databases, everything.  But that can be pretty complicated, so let's work
up to it slowly.  Here's the simplest possible ".awsboxen.json" file::


    {
      "processes": [ "server.js "]
    }

Yes, this is just an awsbox deployment file!  At deploy time awsboxen will
fill in some sensible defaults, assuming that you want a single all-in-one
server instance like you'd get from vanilla awsbox.  It will expand the 
description into something like the following::

    {
      // Description automatically generated from repo name.

      "Description": "awsboxen deployment of example-server",

      // Enumerates the different types of boxen in this deployment.
      // Each entry is an awsbox configuration, which will be frozen into
      // an AMI and can be referenced in the "Resources" section.
      //
      // In this case, we have only a single type of box.

      "Boxen": {
        "AWSBox": {
          "Type": "AWSBox",
          "Properties": { "processes": [ "server.js "] }
        }
      },

      // Enumerates the physical resources that make up the deployment.
      // This might include a load balancer, a database instance, and some
      // EC2 instances running boxen that were defined above.
      //
      // In the default configuration, we get a single server instance and
      // a supporting security group.

      "Resources": {

        "AWSBoxServer": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": { "Ref": "AWSBoxAMI" },
          }
        },

        "AWSBoxSecurityGroup": {
            ...security group guff elided...
        }

      }

    }


As your needs grow, you can fill in more and more of the deployment description
manually rather than relying on the defaults.

You can also create multiple deployment profiles (e.g. one for dev, one for
production) by populating the key "Profiles" with additional CloudFormation
configs.  It will be merged into the main configuration when that profile
is selected::

    {

      "Boxen": { "WebHead": { "processes": [ "server.js "] } },

      //  By default we use a small instance, for development purposes.

      "Resources": {
        "WebHead": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": { "Ref": "WebHeadAMI" },
          }
        }
      },

      //  But we use a large instance when running in production.

      "Profiles" {
        "Production": {
          "Resources": { "WebHead": { "Properties": {
            "InstanceType": "m1.large"
          }}}
        }
      }
      
    }

The special profile name "Default" will be used if present when no explicit
profile has been specified on the command-line.


The CloudFormation language can be pretty cumbersome, so we offer some handy
shortcuts.  You can use YAML instead of JSON, and if you specify a directory
instead of a file then it will produce a dict with keys corresponding to
child file names.  The above example could be produced from a directory
structure like this::

    .awsboxen/
        Description.yaml
        Resources.yaml
        Boxen/
           WebHead.json
        Profiles/
           Production.json


To build custom AMIs that do not include all of the software installed
on awsbox by default, you can specify an explicit box type.  This example
includes one AMI build with awsbox and one built using a custom build
script::

    {
      "Boxen": {
        "WebHead": {
          // Boxen are assumed to be of type "AWSBox" by default
          // Their properties hash is the awsbox config.
          "Type": "AWSBox",
          "Properties": { "processes": [ "server.js "] }
        },
        "StorageNode" : {
          // This box will be built from a base AMI, using a custom script.
          // Script is located relative to root of project git repo.
          "Type":  "AWSBoxen::BuildScript",
          "Properties": {
            "BaseAMI": "ami-XXXXXX",
            "BuildScript": "scripts/build_storage_node.sh"
          }
      },
    }

Currently only "AWSBox" and "AWSBoxen::BuildScript" types are supported.
Additional build mechanisms (e.g. puppet or chef) may be supported in the
future.


Handling Secrets
----------------

Rather than putting secrets (e.g. database passwords) directly in the
cloudformation template, you should define them as parameters and specify
them on the command-line at deployment time.  For example, here is how an
RDS database instance might be declared with its password as a parameter::

    {
      "Parameters": {
        "DBPassword": {
          "Default": "plaintext_decoy_password",
          "Type": "String",
          "Description": "password to use for database access"
        }
      },

      "Resources": {
        "Database": {
          "Type" : "AWS::RDS::DBInstance",
          "Properties" : {
            "DBName": "mydatabase",
            "Engine": "MySQL",
            "MasterUsername": "myuser",
            "MasterUserPassword": {"Ref": "DBPassword"},
            "DBInstanceClass": "db.m1.small",
            "AllocatedStorage": "5"
          }
        }
      }
    }


At deployment time, the value of the password can be provided on the
command-line like so::

    $> awsboxen deploy -D DBPassword=MySecretPassword stack-name


If the number of parameters grows large, you can store them in a JSON-formatted
file for eash loading like so::

    $> echo '{"DBPassword": "MySecretPassword"}' > params.json
    $> 
    $> awsboxen deploy -F params.json stack-name
    [...deployment commences...]
    

You can even encrypt the file using gpg, and awsboxen will decrypt it on the
fly when deploying your stack, shelling out to gpg to prompt for the necessary
password::

    $> gpg --cipher-algo=aes256 --symmetric --armor params.json
    Enter passphrase:  ********
    Repeat passphrase:  ********
    $> 
    $> awsboxen deploy -F params.json.asc stack-name
    gpg: AES256 encrypted data
    Enter passphrase: ********
    gpg: encrypted with 1 passphrase
    [...deployment commences...]



Things To Do
------------

These are the things that don't work yet, in roughly the order I plan to
attempt working on them:

  * Controllable logging/verbosity so that you can get feedback during
    the execution of various commands.
  * Try to read the event stream during creation/teardown, for better
    feedback on what's happening
  * Allow pointing to a custom awsboxen.json file, rather than always
    ready it out of the current directory.
  * `awsboxen info <stack-name> <resource-name>` to get information
    about particular resources in the stack.  May be useful for e.g.
    listing all the instances in an auto-scale group.
  * Add a "deploy --dry-run" command which prints a summary of the changes
    that will be made, and highlights any potential downtime or destruction
    of existing resources.
  * Cleaning up of old AMIs, and related snapshots.
