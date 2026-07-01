app._auth = (function(app) {
	var user = {}
	function setToken(token){
		localStorage.setItem('APIToken', token);
	}

	function getToken(){
		return localStorage.getItem('APIToken');
	}

	function isLoggedIn(callack){
		if(getToken()){
			return app.api.get('user/me', function(error, data){
				if(!error) app.auth.user = data;
				return callack(error, data);
			});
		}else{
			callack(null, false);
		}
	}

	function logIn(args, callack){
		app.api.post('auth/login', args, function(error, data){
			if(data.login){
				setToken(data.token);
			}
			callack(error, !!data.token);
		});
	}

	function logOut(callack){
		localStorage.removeItem('APIToken');
		callack();
	}

	function makeUserFromInvite(args, callack){
		app.api.post('auth/invite/'+ args.token, args, function(error, data){
			if(data.login){
				callack(null, data);
				setToken(data.token);
			}
			callack(error, !!data.token);
		});
	}

	return {
		getToken: getToken,
		setToken: setToken,
		isLoggedIn: isLoggedIn,
		logIn: logIn,
		logOut: logOut,
		makeUserFromInvite: makeUserFromInvite,
	}

})(app);

app.user = (function(app){
	function list(callack){
		return app.api.get('user/?detail=true', function(error, data){
			if(callack) callack(error, data);
		});
	}

	function add(args, callack){
		app.api.post('user/', args, function(error, data){
			callack(error, data);
		});
	}

	function remove(args, callack){
		if(!confirm('Delete '+ args.uid+ 'user?')) return false;
		app.api.delete('user/'+ args.uid, function(error, data){
			callack(error, data);
		});
	}

	function changePassword(args, callack){
		app.api.put('users/'+ arg.uid || '', args, function(error, data){
			callack(error, data);
		});
	}

	function createInvite(callack){
		app.api.post('user/invite', {}, function(error, data, status){
			callack(error, data);	
		});
	}

	function consumeInvite(args){
		app.api.post('/auth/invite/'+args.token, args, function(error, data){
			if(data.token){
				app.auth.setToken(data.token)
				return callack(null, true)
			}
			callack(error)
		});
	}

	function setActive(uid, active, callack){
		app.api.put('user/' + uid + '/active', {active: active}, function(error, data){
			if(callack) callack(error, data);
		});
	}

	return {list, remove, createInvite, setActive};

})(app);

app.group = (function(app){
	function list(callack){
		return app.api.get('group?detail=true', function(error, data){
			if(callack) callack(error, data);
		});
	}

	function get(cn, callack){
		return app.api.get('group/' + cn + '?detail=true', function(error, data){
			if(callack) callack(error, data);
		});
	}

	function remove(args, callack){
		app.api.delete('group/'+args.cn, function(error, data){
			callack(error, data);
		});
	}

	return {list, get, remove}
})(app)

app.oauthClient = (function(app){
	function list(callack){
		return app.api.get('oauth/client/', function(error, data){
			if(callack) callack(error, data);
		});
	}

	function add(args, callack){
		app.api.post('oauth/client/', args, function(error, data){
			callack(error, data);
		});
	}

	function remove(args, callack){
		if(!confirm('Delete OAuth client "' + args.client_id + '"?')) return false;
		app.api.delete('oauth/client/' + args.client_id, function(error, data){
			callack(error, data);
		});
	}

	function update(args, callack){
		app.api.put('oauth/client/' + args.client_id, args, function(error, data){
			callack(error, data);
		});
	}

	function rotateSecret(args, callack){
		app.api.post('oauth/client/' + args.client_id + '/rotate', {}, function(error, data){
			callack(error, data);
		});
	}

	return { list, add, remove, update, rotateSecret };
})(app);

app.impersonate = (function(app){
	function create(uid, callack){
		app.api.post('auth/impersonate/' + uid, {}, function(error, data){
			callack(error, data);
		});
	}

	function revoke(uid, callack){
		app.api.delete('auth/impersonate/' + uid, function(error, data){
			callack(error, data);
		});
	}

	return {create, revoke};
})(app);

app.token = (function(app){
	function list(name, callack){
		if($.isFunction(name)){
			callack = name;
			name = '';
		}
		return app.api.get('token/' + name + '?detail=true', function(error, data){
			if(callack) callack(error, data);
		});
	}

	return {list}
})(app)

