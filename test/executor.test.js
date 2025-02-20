// Copyright IBM Corp. 2014,2016. All Rights Reserved.
// Node module: loopback-boot
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

var async = require('async');
var boot = require('../');
var path = require('path');
var loopback = require('loopback');
var assert = require('assert');
var expect = require('chai').expect;
var fs = require('fs-extra');
var sandbox = require('./helpers/sandbox');
var appdir = require('./helpers/appdir');
var supertest = require('supertest');
var os = require('os');

var SIMPLE_APP = path.join(__dirname, 'fixtures', 'simple-app');
var ENV_APP = path.join(__dirname, 'fixtures', 'env-app');

var app;

describe('executor', function() {
  beforeEach(sandbox.reset);

  beforeEach(appdir.init);

  beforeEach(function() {
    app = loopback();

    // process.bootFlags is used by simple-app/boot/*.js scripts
    process.bootFlags = [];
  });

  afterEach(function() {
    delete process.bootFlags;
  });

  var dummyInstructions = someInstructions({
    config: {
      port: 0,
      host: '127.0.0.1',
      restApiRoot: '/rest-api',
      foo: { bar: 'bat' },
      baz: true,
    },
    models: [
      {
        name: 'User',
        config: {
          dataSource: 'the-db',
        },
      },
    ],
    dataSources: {
      'the-db': {
        connector: 'memory',
        defaultForType: 'db',
      },
    },
  });

  describe('when booting', function() {
    it('should set the `booting` flag during execution', function(done) {
      expect(app.booting).to.be.undefined();
      boot.execute(app, simpleAppInstructions(), function(err) {
        expect(err).to.be.undefined();
        expect(process.bootingFlagSet).to.be.true();
        expect(app.booting).to.be.false();
        done();
      });
    });

    it('should emit the `booted` event in the next tick', function(done) {
      boot.execute(app, dummyInstructions, function(err) {
        expect(err).to.be.undefined();
      });
      app.on('booted', function() {
        // This test fails with a timeout when the `booted` event has not been
        // emitted correctly
        done();
      });
    });

    it('should work when called synchronously', function() {
      boot.execute(app, dummyInstructions);
    });
  });

  it('configures models', function() {
    boot.execute(app, dummyInstructions);
    assert(app.models);
    assert(app.models.User);
    assert.equal(app.models.User, app.registry.getModel('User'),
      'Boot should not have extended built-in User model');
    assertValidDataSource(app.models.User.dataSource);
    assert.isFunc(app.models.User, 'find');
    assert.isFunc(app.models.User, 'create');
  });

  it('defines and customizes models', function() {
    appdir.writeFileSync('models/Customer.js', 'module.exports = ' +
      function(Customer) {
        Customer.settings._customized = 'Customer';
        Customer.base.settings._customized = 'Base';
      }.toString());

    boot.execute(app, someInstructions({
      models: [
        {
          name: 'Customer',
          config: { dataSource: 'db' },
          definition: {
            name: 'Customer',
            base: 'User',
          },
          sourceFile: path.resolve(appdir.PATH, 'models', 'Customer.js'),
        },
      ],
    }));

    expect(app.models.Customer).to.exist();
    expect(app.models.Customer.settings._customized).to.be.equal('Customer');
    var UserModel = app.registry.getModel('User');
    expect(UserModel.settings._customized).to.equal('Base');
  });

  it('defines model without attaching it', function() {
    boot.execute(app, someInstructions({
      models: [
        {
          name: 'Vehicle',
          config: undefined,
          definition: {
            name: 'Vehicle',
          },
          sourceFile: undefined,
        },
        {
          name: 'Car',
          config: { dataSource: 'db' },
          definition: {
            name: 'Car',
            base: 'Vehicle',
          },
          sourceFile: undefined,
        },
      ],
    }));

    expect(Object.keys(app.models)).to.eql(['Car']);
  });

  it('attaches models to data sources', function() {
    boot.execute(app, dummyInstructions);
    assert.equal(app.models.User.dataSource, app.dataSources.theDb);
  });

  it('defines all models first before running the config phase', function() {
    appdir.writeFileSync('models/Customer.js', 'module.exports = ' +
      function(Customer/*, Base*/) {
        Customer.on('attached', function() {
          Customer._modelsWhenAttached =
            Object.keys(Customer.modelBuilder.models);
        });
      }.toString());

    boot.execute(app, someInstructions({
      models: [
        {
          name: 'Customer',
          config: { dataSource: 'db' },
          definition: { name: 'Customer' },
          sourceFile: path.resolve(appdir.PATH, 'models', 'Customer.js'),
        },
        {
          name: 'UniqueName',
          config: { dataSource: 'db' },
          definition: { name: 'UniqueName' },
          sourceFile: undefined,
        },
      ],
    }));

    expect(app.models.Customer._modelsWhenAttached).to.include('UniqueName');
  });

  it('defines models in the local app registry', function() {
    app = loopback({ localRegistry: true });
    boot.execute(app, someInstructions({
      models: [
        {
          name: 'LocalCustomer',
          config: { dataSource: 'db' },
          definition: { name: 'LocalCustomer' },
          sourceFile: undefined,
        },
      ],
    }));

    expect(Object.keys(loopback.registry.modelBuilder.models), 'global models')
      .to.not.contain('LocalCustomer');
    expect(Object.keys(app.registry.modelBuilder.models), 'local models')
      .to.contain('LocalCustomer');
  });

  it('throws on bad require() call inside boot script', function() {
    var file = appdir.writeFileSync('boot/badScript.js',
      'require("doesnt-exist"); module.exports = {};');

    function doBoot() {
      boot.execute(app, someInstructions({ files: { boot: [file] }}));
    }

    expect(doBoot).to.throw(/Cannot find module \'doesnt-exist\'/);
  });

  it('instantiates data sources', function() {
    boot.execute(app, dummyInstructions);
    assert(app.dataSources);
    assert(app.dataSources.theDb);
    assertValidDataSource(app.dataSources.theDb);
    assert(app.dataSources.TheDb);
  });

  it('does not call autoAttach', function() {
    boot.execute(app, dummyInstructions);

    // loopback-datasource-juggler quirk:
    // Model.dataSources has modelBuilder as the default value,
    // therefore it's not enough to assert a false-y value
    var actual = loopback.Email.dataSource instanceof loopback.DataSource ?
      'attached' : 'not attached';
    expect(actual).to.equal('not attached');
  });

  it('skips definition of already defined LoopBack models', function() {
    var builtinModel = {
      name: 'User',
      definition: fs.readJson(
        require.resolve('loopback/common/models/user.json')
      ),
      config: { dataSource: 'db' },
      sourceFile: require.resolve('loopback/common/models/user.js'),
    };
    builtinModel.definition.redefined = true;

    boot.execute(app, someInstructions({ models: [builtinModel] }));

    expect(app.models.User.settings.redefined, 'redefined').to.not.equal(true);
  });

  describe('with boot and models files', function() {
    beforeEach(function() {
      boot.execute(app, simpleAppInstructions());
    });

    afterEach(function() {
      delete process.bootFlags;
    });

    it('should run `boot/*` files', function(done) {
      // scripts are loaded by the order of file names
      expect(process.bootFlags).to.eql([
        'barLoaded',
        'barSyncLoaded',
        'fooLoaded',
        'promiseLoaded',
        'thenableLoaded',
        'barStarted',
      ]);

      // bar finished happens in the next tick
      // barSync executed after bar finished
      setTimeout(function() {
        expect(process.bootFlags).to.eql([
          'barLoaded',
          'barSyncLoaded',
          'fooLoaded',
          'promiseLoaded',
          'thenableLoaded',
          'barStarted',
          'barFinished',
          'barSyncExecuted',
          'promiseStarted',
          'promiseFinished',
          'thenableStarted',
          'thenableFinished',
          'umdLoaded',
        ]);
        done();
      }, 10);
    });
  });

  describe('with boot with callback', function() {
    it('should run `boot/*` files asynchronously', function(done) {
      boot.execute(app, simpleAppInstructions(), function() {
        expect(process.bootFlags).to.eql([
          'barLoaded',
          'barSyncLoaded',
          'fooLoaded',
          'promiseLoaded',
          'thenableLoaded',
          'barStarted',
          'barFinished',
          'barSyncExecuted',
          'promiseStarted',
          'promiseFinished',
          'thenableStarted',
          'thenableFinished',
          'umdLoaded',
        ]);
        done();
      });
    });

    it('searches boot file extensions specified in options.scriptExtensions',
    function(done) {
      var options = {
        app: app,
        appRootDir: SIMPLE_APP,
        scriptExtensions: ['.customjs', '.customjs2'],
      };
      boot.execute(app, boot.compile(options), function(err) {
        if (err) return done(err);
        expect(process.bootFlags, 'process: bootFlags').to.eql([
          'customjs',
          'customjs2',
        ]);
        done();
      });
    });
  });

  describe('with boot script returning a rejected promise', function() {
    before(function() {
      // Tell simple-app/boot/reject.js to return a rejected promise
      process.rejectPromise = true;
    });

    after(function() {
      delete process.rejectPromise;
    });

    it('receives rejected promise as callback error',
    function(done) {
      boot.execute(app, simpleAppInstructions(), function(err) {
        expect(err).to.exist.and.be.an.instanceOf(Error)
          .with.property('message', 'reject');
        done();
      });
    });
  });

  describe('with boot script throwing an error', function() {
    before(function() {
      // Tell simple-app/boot/throw.js to throw an error
      process.throwError = true;
    });

    after(function() {
      delete process.throwError;
    });

    it('receives thrown error as callback errors',
    function(done) {
      boot.execute(app, simpleAppInstructions(), function(err) {
        expect(err).to.exist.and.be.an.instanceOf(Error)
          .with.property('message', 'throw');
        done();
      });
    });
  });

  describe('with boot script returning a promise and calling callback',
    function() {
      before(function() {
        process.promiseAndCallback = true;
      });

      after(function() {
        delete process.promiseAndCallback;
      });

      it('should only call the callback once', function(done) {
        // Note: Mocha will fail this test if done() is called twice
        boot.execute(app, simpleAppInstructions(), done);
      });
    }
  );

  describe('for mixins', function() {
    var options;
    beforeEach(function() {
      appdir.writeFileSync('custom-mixins/example.js',
        'module.exports = ' +
        'function(Model, options) {}');

      appdir.writeFileSync('custom-mixins/time-stamps.js',
        'module.exports = ' +
        'function(Model, options) {}');

      appdir.writeConfigFileSync('custom-mixins/time-stamps.json', {
        name: 'Timestamping',
      });

      options = {
        appRootDir: appdir.PATH,
      };
    });

    it('defines mixins from instructions - using `mixinDirs`', function() {
      options.mixinDirs = ['./custom-mixins'];
      boot(app, options);

      var modelBuilder = app.registry.modelBuilder;
      var registry = modelBuilder.mixins.mixins;
      expect(Object.keys(registry)).to.eql(['Example', 'Timestamping']);
    });

    it('defines mixins from instructions - using `mixinSources`', function() {
      options.mixinSources = ['./custom-mixins'];
      boot(app, options);

      var modelBuilder = app.registry.modelBuilder;
      var registry = modelBuilder.mixins.mixins;
      expect(Object.keys(registry)).to.eql(['Example', 'Timestamping']);
    });
  });

  describe('with PaaS and npm env variables', function() {
    beforeEach(function cleanEnvironment() {
      // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
      delete process.env.npm_config_host;
      delete process.env.OPENSHIFT_SLS_IP;
      delete process.env.OPENSHIFT_NODEJS_IP;
      delete process.env.VCAP_APP_HOST;
      delete process.env.HOST;
      delete process.env.npm_package_config_host;

      delete process.env.npm_config_port;
      delete process.env.OPENSHIFT_SLS_PORT;
      delete process.env.OPENSHIFT_NODEJS_PORT;
      delete process.env.VCAP_APP_PORT;
      delete process.env.PORT;
      delete process.env.npm_package_config_port;
    });

    function bootWithDefaults() {
      app = loopback();
      boot.execute(app, someInstructions({
        config: {
          port: undefined,
          host: undefined,
        },
      }));
    }

    it('should apply env passed in option object', function() {
      boot.execute(app, someInstructions({ env: 'custom_env' }));
      expect(app.get('env')).to.equal('custom_env');
    });

    it('should honor host and port', function() {
      function assertHonored(portKey, hostKey) {
        process.env[hostKey] = randomPort();
        process.env[portKey] = randomHost();
        bootWithDefaults();
        assert.equal(app.get('port'), process.env[portKey], portKey);
        assert.equal(app.get('host'), process.env[hostKey], hostKey);
        delete process.env[portKey];
        delete process.env[hostKey];
      }

      assertHonored('OPENSHIFT_SLS_PORT', 'OPENSHIFT_NODEJS_IP');
      assertHonored('npm_config_port', 'npm_config_host');
      assertHonored('npm_package_config_port', 'npm_package_config_host');
      assertHonored('OPENSHIFT_SLS_PORT', 'OPENSHIFT_SLS_IP');
      assertHonored('VCAP_APP_PORT', 'VCAP_APP_HOST');
      assertHonored('PORT', 'HOST');
    });

    it('should prioritize host sources', function() {
      // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
      /*eslint-disable camelcase*/
      process.env.npm_config_host = randomHost();
      process.env.OPENSHIFT_SLS_IP = randomHost();
      process.env.OPENSHIFT_NODEJS_IP = randomHost();
      process.env.VCAP_APP_HOST = randomHost();
      process.env.HOST = randomHost();
      process.env.npm_package_config_host = randomHost();

      bootWithDefaults();
      assert.equal(app.get('host'), process.env.npm_config_host);
      /*eslint-enable camelcase*/
    });

    it('should prioritize port sources', function() {
      /*eslint-disable camelcase*/
      process.env.npm_config_port = randomPort();
      process.env.OPENSHIFT_SLS_PORT = randomPort();
      process.env.OPENSHIFT_NODEJS_PORT = randomPort();
      process.env.VCAP_APP_PORT = randomPort();
      process.env.PORT = randomPort();
      process.env.npm_package_config_port = randomPort();

      bootWithDefaults();
      assert.equal(app.get('port'), process.env.npm_config_port);
      /*eslint-enable camelcase*/
    });

    function randomHost() {
      return Math.random().toString().split('.')[1];
    }

    function randomPort() {
      return Math.floor(Math.random() * 10000);
    }

    it('should honor 0 for free port', function() {
      boot.execute(app, someInstructions({ config: { port: 0 }}));
      assert.equal(app.get('port'), 0);
    });

    it('should default to port 3000', function() {
      boot.execute(app, someInstructions({ config: { port: undefined }}));
      assert.equal(app.get('port'), 3000);
    });

    it('should respect named pipes port values in ENV', function() {
      var NAMED_PORT = '\\.\\pipe\\test';
      process.env.PORT = NAMED_PORT;
      boot.execute(app, someInstructions({ config: { port: 3000 }}));
      assert.equal(app.get('port'), NAMED_PORT);
    });
  });

  describe('with middleware.json', function() {
    beforeEach(function() {
      delete process.env.restApiRoot;
    });

    it('should parse a simple config variable', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { path: '${restApiRoot}' }
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.path).to.equal(app.get('restApiRoot'));
        done();
      });
    });

    it('should parse simple config variable from env var', function(done) {
      process.env.restApiRoot = '/url-from-env-var';
      boot.execute(app, simpleMiddlewareConfig('routes',
        { path: '${restApiRoot}' }
      ));

      supertest(app).get('/url-from-env-var').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.path).to.equal('/url-from-env-var');
        done();
      });
    });

    it('dynamic variable from `env var` should have' +
    ' precedence over app.get()', function(done) {
      process.env.restApiRoot = '/url-from-env-var';
      var bootInstructions;
      bootInstructions = simpleMiddlewareConfig('routes',
        { path: '${restApiRoot}' });
      bootInstructions.config = { restApiRoot: '/url-from-config' };
      boot.execute(app, someInstructions(bootInstructions));

      supertest(app).get('/url-from-env-var').end(function(err, res) {
        if (err) return done(err);
        expect(app.get('restApiRoot')).to.equal('/url-from-config');
        expect(res.body.path).to.equal('/url-from-env-var');
        done();
      });
    });

    it('should parse multiple config variables', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { path: '${restApiRoot}', env: '${env}' }
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.path).to.equal(app.get('restApiRoot'));
        expect(res.body.env).to.equal(app.get('env'));
        done();
      });
    });

    it('should parse config variables in an array', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { paths: ['${restApiRoot}'] }
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.paths).to.eql(
          [app.get('restApiRoot')]
          );
        done();
      });
    });

    it('should parse config variables in an object', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { info: { path: '${restApiRoot}' }}
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.info).to.eql({
          path: app.get('restApiRoot'),
        });
        done();
      });
    });

    it('should parse config variables in a nested object', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { nested: { info: { path: '${restApiRoot}' }}}
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.nested).to.eql({
          info: { path: app.get('restApiRoot') },
        });
        done();
      });
    });

    it('should parse config variables with null values', function(done) {
      boot.execute(app, simpleMiddlewareConfig('routes',
        { nested: { info: { path: '${restApiRoot}', some: null }}}
      ));

      supertest(app).get('/').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.nested).to.eql({
          info: {
            path: app.get('restApiRoot'),
            some: null,
          },
        });
        done();
      });
    });

    it('should not parse invalid config variables', function(done) {
      var invalidDataTypes = [undefined, function() {}];
      async.each(invalidDataTypes, function(invalidDataType, cb) {
        var config = simpleMiddlewareConfig('routes', {
          path: invalidDataType,
        });
        boot.execute(app, config);

        supertest(app)
          .get('/')
          .end(function(err, res) {
            expect(err).to.be.null();
            expect(res.body.path).to.be.undefined();
            cb();
          });
      }, done);
    });

    it('should parse valid config variables', function(done) {
      var config = simpleMiddlewareConfig('routes', {
        props: ['a', '${vVar}', 1, true, function() {}, { x: 1, y: '${y}' }],
      });
      boot.execute(app, config);

      supertest(app)
        .get('/')
        .end(function(err, res) {
          expect(err).to.be.null();
          done();
        });
    });

    it('should preserve object prototypes', function(done) {
      var config = simpleMiddlewareConfig(
        'routes',
        // IMPORTANT we need more than one item to trigger the original issue
        [/^\/foobar/, /^\/another/],
        {});
      boot.execute(app, config);

      supertest(app).get('/foobar')
        .expect(200)
        .end(done);
    });
  });

  describe('with component-config.json', function() {
    beforeEach(function() {
      delete process.env.DYNAMIC_ENVVAR;
      delete process.env.DYNAMIC_VARIABLE;
    });

    it('should parse a simple config variable', function(done) {
      boot.execute(app, simpleComponentConfig(
        { path: '${restApiRoot}' }
      ));

      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.path).to.equal(app.get('restApiRoot'));
        done();
      });
    });

    it('should parse config from `env-var` and `config`', function(done) {
      var bootInstructions = simpleComponentConfig(
        {
          path: '${restApiRoot}',
          fromConfig: '${DYNAMIC_CONFIG}',
          fromEnvVar: '${DYNAMIC_ENVVAR}',
        }
      );

      // result should get value from config.json
      bootInstructions.config['DYNAMIC_CONFIG'] = 'FOOBAR-CONFIG';
      // result should get value from env var
      process.env.DYNAMIC_ENVVAR = 'FOOBAR-ENVVAR';

      boot.execute(app, bootInstructions);
      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.fromConfig).to.equal('FOOBAR-CONFIG');
        expect(res.body.fromEnvVar).to.equal('FOOBAR-ENVVAR');
        done();
      });
    });

    it('`env-var` should have precedence over `config`', function(done) {
      var key = 'DYNAMIC_VARIABLE';
      var bootInstructions = simpleComponentConfig({
        path: '${restApiRoot}',
        isDynamic: '${' + key + '}',
      });
      bootInstructions.config[key] = 'should be overwritten';
      process.env[key] = 'successfully overwritten';

      boot.execute(app, bootInstructions);
      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.isDynamic).to.equal('successfully overwritten');
        done();
      });
    });

    it('should parse multiple config variables', function(done) {
      boot.execute(app, simpleComponentConfig(
        { path: '${restApiRoot}', env: '${env}' }
      ));

      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.path).to.equal(app.get('restApiRoot'));
        expect(res.body.env).to.equal(app.get('env'));
        done();
      });
    });

    it('should parse config variables in an array', function(done) {
      boot.execute(app, simpleComponentConfig(
        { paths: ['${restApiRoot}'] }
      ));

      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.paths).to.eql(
          [app.get('restApiRoot')]
          );
        done();
      });
    });

    it('should parse config variables in an object', function(done) {
      boot.execute(app, simpleComponentConfig(
        { info: { path: '${restApiRoot}' }}
      ));

      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.info).to.eql({
          path: app.get('restApiRoot'),
        });
        done();
      });
    });

    it('should parse config variables in a nested object', function(done) {
      boot.execute(app, simpleComponentConfig(
        { nested: { info: { path: '${restApiRoot}' }}}
      ));

      supertest(app).get('/component').end(function(err, res) {
        if (err) return done(err);
        expect(res.body.nested).to.eql({
          info: { path: app.get('restApiRoot') },
        });
        done();
      });
    });
  });

  it('calls function exported by boot/init.js', function() {
    var file = appdir.writeFileSync('boot/init.js',
      'module.exports = function(app) { app.fnCalled = true; };');

    delete app.fnCalled;
    boot.execute(app, someInstructions({ files: { boot: [file] }}));
    expect(app.fnCalled, 'exported fn was called').to.be.true();
  });

  it('configures middleware', function(done) {
    var pushNamePath = require.resolve('./helpers/push-name-middleware');

    boot.execute(app, someInstructions({
      middleware: {
        phases: ['initial', 'custom'],
        middleware: [
          {
            sourceFile: pushNamePath,
            config: {
              phase: 'initial',
              params: 'initial',
            },
          },
          {
            sourceFile: pushNamePath,
            config: {
              phase: 'custom',
              params: 'custom',
            },
          },
          {
            sourceFile: pushNamePath,
            config: {
              phase: 'routes',
              params: 'routes',
            },
          },
          {
            sourceFile: pushNamePath,
            config: {
              phase: 'routes',
              enabled: false,
              params: 'disabled',
            },
          },
        ],
      },
    }));

    supertest(app)
      .get('/')
      .end(function(err, res) {
        if (err) return done(err);
        var names = (res.headers.names || '').split(',');
        expect(names).to.eql(['initial', 'custom', 'routes']);
        done();
      });
  });

  it('configures middleware using shortform', function(done) {
    boot.execute(app, someInstructions({
      middleware: {
        middleware: [
          {
            sourceFile: require.resolve('loopback'),
            fragment: 'static',
            config: {
              phase: 'files',
              params: path.join(__dirname, './fixtures/simple-app/client/'),
            },
          },
        ],
      },
    }));

    supertest(app)
      .get('/')
      .end(function(err, res) {
        if (err) return done(err);
        var EXPECTED_TEXT = '<!DOCTYPE html>\n<html>\n<head lang="en">\n' +
          '    <meta charset="UTF-8">\n    <title>simple-app</title>\n' +
          '</head>\n<body>\n<h1>simple-app</h1>\n' +
          '</body>\n</html>';
        expect(normalizeEols(res.text)).to.eql(normalizeEols(EXPECTED_TEXT));
        done();
      });
  });

  it('configures middleware (end-to-end)', function(done) {
    boot.execute(app, simpleAppInstructions());

    supertest(app)
      .get('/')
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.headers.names).to.equal('custom-middleware');
        expect(res.headers.umd).to.equal('success');
        done();
      });
  });

  it('configures components', function() {
    appdir.writeConfigFileSync('component-config.json', {
      './components/test-component': {
        option: 'value',
      },
    });

    appdir.writeFileSync('components/test-component/index.js',
      'module.exports = ' +
      'function(app, options) { app.componentOptions = options; }');

    boot(app, appdir.PATH);

    expect(Object.keys(require.cache)).to.include(
      appdir.resolve('components/test-component/index.js'));

    expect(app.componentOptions).to.eql({ option: 'value' });
  });

  it('disables component when configuration is not set', function() {
    appdir.writeConfigFileSync('component-config.json', {
      './components/test-component': false,
    });

    appdir.writeFileSync('components/test-component/index.js',
      'module.exports = ' +
      'function(app, options) { app.componentOptions = options; }');

    boot(app, appdir.PATH);

    expect(Object.keys(require.cache)).to.not.include(
      appdir.resolve('components/test-component/index.js'));
  });

  it('disable component if overrided by production configuration', function() {
    appdir.writeConfigFileSync('component-config.json', {
      './components/test-component': {},
    });
    appdir.writeConfigFileSync('component-config.production.json', {
      './components/test-component': null,
    });

    appdir.writeFileSync('components/test-component/index.js',
      'module.exports = ' +
      'function(app, options) { app.componentOptions = options; }');

    boot(app, { appRootDir: appdir.PATH, env: 'production' });

    expect(Object.keys(require.cache)).to.not.include(
      appdir.resolve('components/test-component/index.js'));
  });

  it('configures middleware (that requires `this`)', function(done) {
    var passportPath = require.resolve('./fixtures/passport');

    boot.execute(app, someInstructions({
      middleware: {
        phases: ['auth'],
        middleware: [
          {
            sourceFile: passportPath,
            fragment: 'initialize',
            config: {
              phase: 'auth:before',
            },
          },
        ],
      },
    }));

    supertest(app)
      .get('/')
      .expect('passport', 'initialized', done);
  });

  describe('when booting with env', function() {
    it('should set the `booting` flag during execution', function(done) {
      expect(app.booting).to.be.undefined();
      boot.execute(app, envAppInstructions(), function(err) {
        if (err) return done(err);
        expect(app.booting).to.be.false();
        expect(process.bootFlags).to.not.have.property('barLoadedInTest');
        done();
      });
    });
  });

  describe('when booting with lazy connect', function() {
    var SAMPLE_INSTRUCTION = someInstructions({
      dataSources: {
        lazyConnector: {
          connector: 'testLazyConnect',
          name: 'lazyConnector',
        },
      },
    });
    var connectTriggered = true;

    beforeEach(function() {
      app.connector('testLazyConnect', {
        initialize: function(dataSource, callback) {
          if (dataSource.settings.lazyConnect) {
            connectTriggered = false;
          } else {
            connectTriggered = true;
          }
        },
      });
    });

    it('should trigger connect with ENV undefined', function(done) {
      delete process.env.LB_LAZYCONNECT_DATASOURCES;
      boot.execute(app, SAMPLE_INSTRUCTION, function() {
        expect(connectTriggered).to.equal(true);
        done();
      });
    });

    it('should not trigger connect with ENV true', function(done) {
      process.env.LB_LAZYCONNECT_DATASOURCES = 'true';
      boot.execute(app, SAMPLE_INSTRUCTION, function() {
        expect(connectTriggered).to.equal(false);
        done();
      });
    });

    it('should trigger connect with ENV false', function(done) {
      process.env.LB_LAZYCONNECT_DATASOURCES = 'false';
      boot.execute(app, SAMPLE_INSTRUCTION, function() {
        expect(connectTriggered).to.equal(true);
        done();
      });
    });

    it('should trigger connect with ENV 0', function(done) {
      process.env.LB_LAZYCONNECT_DATASOURCES = '0';
      boot.execute(app, SAMPLE_INSTRUCTION, function() {
        expect(connectTriggered).to.equal(true);
        done();
      });
    });
  });

  describe('dynamic configuration for datasources.json', function() {
    beforeEach(function() {
      delete process.env.DYNAMIC_HOST;
      delete process.env.DYNAMIC_PORT;
    });

    it('should convert dynamic variable for datasource', function(done) {
      var datasource = {
        mydb: {
          host: '${DYNAMIC_HOST}',
          port: '${DYNAMIC_PORT}',
        },
      };
      var bootInstructions = { dataSources: datasource };

      process.env.DYNAMIC_PORT = '10007';
      process.env.DYNAMIC_HOST = '123.321.123.132';

      boot.execute(app, someInstructions(bootInstructions), function() {
        expect(app.datasources.mydb.settings.host).to.equal('123.321.123.132');
        expect(app.datasources.mydb.settings.port).to.equal('10007');
        done();
      });
    });

    it('should resolve dynamic config via app.get()', function(done) {
      var datasource = {
        mydb: { host: '${DYNAMIC_HOST}' },
      };
      var bootInstructions = {
        config: { DYNAMIC_HOST: '127.0.0.4' },
        dataSources: datasource,
      };
      boot.execute(app, someInstructions(bootInstructions), function() {
        expect(app.get('DYNAMIC_HOST')).to.equal('127.0.0.4');
        expect(app.datasources.mydb.settings.host).to.equal(
          '127.0.0.4');
        done();
      });
    });

    it('should take ENV precedence over config.json', function(done) {
      process.env.DYNAMIC_HOST = '127.0.0.2';
      var datasource = {
        mydb: { host: '${DYNAMIC_HOST}' },
      };
      var bootInstructions = {
        config: { DYNAMIC_HOST: '127.0.0.3' },
        dataSources: datasource,
      };
      boot.execute(app, someInstructions(bootInstructions), function() {
        expect(app.get('DYNAMIC_HOST')).to.equal('127.0.0.3');
        expect(app.datasources.mydb.settings.host).to.equal('127.0.0.2');
        done();
      });
    });

    it('empty dynamic conf should resolve as `undefined`', function(done) {
      var datasource = {
        mydb: { host: '${DYNAMIC_HOST}' },
      };
      var bootInstructions = { dataSources: datasource };

      boot.execute(app, someInstructions(bootInstructions), function() {
        expect(app.get('DYNAMIC_HOST')).to.be.undefined();
        expect(app.datasources.mydb.settings.host).to.be.undefined();
        done();
      });
    });
  });
});

function simpleMiddlewareConfig(phase, paths, params) {
  if (params === undefined) {
    params = paths;
    paths = undefined;
  }

  var config = {
    phase: phase,
    params: params,
  };

  if (paths) config.paths = paths;

  return someInstructions({
    middleware: {
      phases: [phase],
      middleware: [
        {
          sourceFile: path.join(__dirname, './fixtures/simple-middleware.js'),
          config: config,
        },
      ],
    },
  });
}

function simpleComponentConfig(config) {
  return someInstructions({
    components: [
      {
        sourceFile: path.join(__dirname, './fixtures/simple-component.js'),
        config: config,
      },
    ],
  });
}

function assertValidDataSource(dataSource) {
  // has methods
  assert.isFunc(dataSource, 'createModel');
  assert.isFunc(dataSource, 'discoverModelDefinitions');
  assert.isFunc(dataSource, 'discoverSchema');
  assert.isFunc(dataSource, 'enableRemote');
  assert.isFunc(dataSource, 'disableRemote');
  assert.isFunc(dataSource, 'defineOperation');
  assert.isFunc(dataSource, 'operations');
}

assert.isFunc = function(obj, name) {
  assert(obj, 'cannot assert function ' + name +
    ' on object that does not exist');
  assert(typeof obj[name] === 'function', name + ' is not a function');
};

function someInstructions(values) {
  var result = {
    config: values.config || {},
    models: values.models || [],
    dataSources: values.dataSources || { db: { connector: 'memory' }},
    middleware: values.middleware || { phases: [], middleware: [] },
    components: values.components || [],
    files: {
      boot: [],
    },
  };

  if (values.env)
    result.env = values.env;

  if (values.files) {
    for (var k in values.files)
      result.files[k] = values.files[k];
  }

  return result;
}

function simpleAppInstructions() {
  // Copy it so that require will happend again
  fs.copySync(SIMPLE_APP, appdir.PATH);
  return boot.compile(appdir.PATH);
}

function envAppInstructions() {
  fs.copySync(ENV_APP, appdir.PATH);
  return boot.compile({
    appRootDir: appdir.PATH,
    env: 'test',
  });
}

function normalizeEols(str) {
  return str.replace(/\r\n/g, '\n');
}
