'use strict';

const path = require('path');
const ejs = require('ejs')
const express = require('express');
const compression = require('compression');

// Set up the express app.
const app = express();

// Hold list of functions to run when the server is ready
app.onListen = [];

// Allow the express app to be exported into other files. 
module.exports = app;

// Hold onto the auth middleware
const middleware = require('./middleware/auth');

// OAuth routes
const { router: oauthRouter, authRouter: oauthApiRouter, discovery } = require('./routes/oauth');

// Grab the projects PubSub
app.contoller = require('./controller');

// Push pubsub over the socket and back.
app.onListen.push(function(){
  app.io.use(middleware.authIO);

  app.contoller.ps.subscribe(/./g, function(data, topic){
    app.io.emit('P2PSub', { topic, data });
  });                                 

  app.io.on('connection', (socket) => {
    // console.log('socket', socket)
    var user = socket.user;
    socket.on('P2PSub', (msg) => {
      app.contoller.ps.publish(msg.topic, {...msg.data, __from:socket.user});
      // socket.broadcast.emit('P2PSub', msg);
    });
  });
}); 

// Gzip text responses (HTML/JS/CSS/JSON). The admin UI loads ~13 separate,
// uncompressed vendor JS/CSS files on every full page navigation (a
// traditional multi-page app, not an SPA) — this alone meaningfully cuts
// bytes-over-the-wire and perceived load time on a real network, where it
// matters far more than on localhost.
app.use(compression());

// load the JSON parser middleware. Express will parse JSON into native objects
// for any request that has JSON in its content type.
app.use(express.json());
app.set('trust proxy', 1);

// Set up the templating engine to build HTML for the front end.
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Have express server static content( images, CSS, browser JS) from the public
// local folder. maxAge is short since this is the app's own JS/CSS, which
// changes on every deploy and isn't cache-busted/fingerprinted.
app.use('/static', express.static(path.join(__dirname, 'public'), {maxAge: '1h'}))

// Routes for front end content.
app.use('/', require('./routes/index'));

// API routes for authentication. 
app.use('/api/auth',  require('./routes/auth'));

// API routes for working with users. All endpoints need to be have valid user.
app.use('/api/user', middleware.auth, require('./routes/user'));

app.use('/api/token', middleware.auth, require('./routes/token'));

app.use('/api/group', middleware.auth, require('./routes/group'));
app.use('/api/notification', middleware.auth, require('./routes/notification'));

// Self-service API tokens (PATs) — owner-scoped, no admin group required.
app.use('/api/api-token', middleware.auth, require('./routes/api_token'));

// OAuth 2.0 / OpenID Connect
app.use('/oauth', oauthRouter);
app.use('/api/oauth/client', middleware.auth, require('./routes/oauth_client'));
app.use('/api/oauth', middleware.auth, oauthApiRouter);
app.get('/.well-known/openid-configuration', discovery);


// Catch 404 and forward to error handler. If none of the above routes are
// used, this is what will be called.
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.message = 'Page not found'
  err.status = 404;
  next(err);
});

// Error handler. This is where `next()` will go on error
app.use(function(err, req, res, next) {
  const SILENT_404S = ['/.well-known/'];
  const isSilent404 = err.status === 404 && SILENT_404S.some(p => req.url.startsWith(p));
  if (!isSilent404) console.error(err.status || res.status, err.name, req.method, req.url);
  if(![401, 404].includes(err.status || res.status)){
    console.error(err.message);
    console.error(err.stack);
    console.error('=========================================');
  }

  res.status(err.status || 500);
  res.json({name: err.name, message: err.message});
});
