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

// Reusable UI widgets. app.ui.tagInput is a generic tag/token field with
// autocomplete; app.ui.groupSelect is a tagInput preloaded with every LDAP
// group, meant to be dropped in anywhere group selection is needed.
app.ui = (function(app){

	// All LDAP group CNs, fetched once and shared across every group selector.
	var _groupsPromise = null;
	function loadGroups(){
		if(!_groupsPromise){
			_groupsPromise = new Promise(function(resolve){
				app.group.list(function(error, data){
					if(error || !data || !data.results){ resolve([]); return; }
					resolve(data.results.map(function(g){ return g.cn || g; }).filter(Boolean).sort());
				});
			});
		}
		return _groupsPromise;
	}
	// Drop the cache (e.g. after a group is created) so the next selector refetches.
	function refreshGroups(){ _groupsPromise = null; return loadGroups(); }

	// opts: { values, options, freeSolo, placeholder, name, separator }
	// Returns a handle: { get, set, add, clear, setOptions, element }.
	function tagInput(mount, opts){
		opts = opts || {};
		var separator = opts.separator != null ? opts.separator : '\n';
		var values    = (opts.values || []).slice();
		var options   = (opts.options || []).slice();
		var freeSolo  = opts.freeSolo !== false; // default: allow custom entries

		var $mount = $(mount).addClass('tag-input form-control shadow').empty();
		var $chips  = $('<span class="tag-chips"></span>');
		var $input  = $('<input type="text" class="tag-typeahead" autocomplete="off">')
			.attr('placeholder', opts.placeholder || 'Type to add…');
		var $menu   = $('<div class="tag-menu"></div>').hide();
		var $hidden = $('<input type="hidden">').attr('name', opts.name || '');
		$mount.append($chips, $input, $menu, $hidden);

		function syncHidden(){
			var joined = values.join(separator);
			$hidden.val(joined).attr('value', joined);
			$mount.trigger('change');
		}
		function renderChips(){
			$chips.empty();
			values.forEach(function(v){
				var $remove = $('<a class="tag-remove" href="#">×</a>').on('click', function(e){
					e.preventDefault(); e.stopPropagation();
					values = values.filter(function(x){ return x !== v; });
					renderChips(); syncHidden();
				});
				$chips.append($('<span class="tag-chip badge"></span>').text(v).append(' ', $remove));
			});
		}
		function suggestions(){
			var q = ($input.val() || '').toLowerCase();
			return options.filter(function(o){
				return values.indexOf(o) === -1 && o.toLowerCase().indexOf(q) !== -1;
			}).slice(0, 10);
		}
		function showMenu(){
			var items = suggestions();
			if(!items.length){ return hideMenu(); }
			$menu.empty();
			items.forEach(function(o){
				$('<div class="tag-option"></div>').text(o).on('mousedown', function(e){
					e.preventDefault(); add(o);
				}).appendTo($menu);
			});
			$menu.show();
		}
		function hideMenu(){ $menu.hide(); }
		function add(val){
			val = (val || '').trim();
			if(!val){ return; }
			if(!freeSolo && options.indexOf(val) === -1){ return; } // reject invalid
			if(values.indexOf(val) === -1){ values.push(val); renderChips(); syncHidden(); }
			$input.val(''); hideMenu();
		}

		$input.on('input focus', showMenu);
		$input.on('keydown', function(e){
			if(e.key === 'Enter' || e.key === ','){
				e.preventDefault();
				add(freeSolo ? $input.val() : (suggestions()[0] || ''));
			}else if(e.key === 'Backspace' && !$input.val() && values.length){
				values.pop(); renderChips(); syncHidden();
			}
		});
		$input.on('blur', function(){ setTimeout(hideMenu, 150); });
		$mount.on('click', function(e){
			if(e.target === $mount[0] || e.target === $chips[0]){ $input.focus(); }
		});

		renderChips(); syncHidden();

		return {
			get: function(){ return values.slice(); },
			set: function(v){ values = (v || []).slice(); renderChips(); syncHidden(); },
			add: add,
			clear: function(){ values = []; renderChips(); syncHidden(); },
			setOptions: function(o){ options = (o || []).slice(); },
			element: $mount,
		};
	}

	// Universal group selector. Preloads all LDAP groups for autocomplete.
	function groupSelect(mount, opts){
		opts = opts || {};
		var handle = tagInput(mount, {
			name: opts.name || 'groups',
			values: opts.values || [],
			options: [],
			freeSolo: opts.freeSolo !== false,
			separator: opts.separator != null ? opts.separator : '\n',
			placeholder: opts.placeholder || 'Type a group name…',
		});
		loadGroups().then(function(groups){ handle.setOptions(groups); });
		return handle;
	}

	return { tagInput: tagInput, groupSelect: groupSelect, loadGroups: loadGroups, refreshGroups: refreshGroups };
})(app);

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

app.apiToken = (function(app){
	function list(callback){
		return app.api.get('api-token/', function(error, data){
			if(callback) callback(error, data);
		});
	}

	function add(args, callback){
		app.api.post('api-token/', args, function(error, data){
			callback(error, data);
		});
	}

	function update(args, callback){
		app.api.put('api-token/' + args.id, args, function(error, data){
			callback(error, data);
		});
	}

	function remove(args, callback){
		app.api.delete('api-token/' + args.id, function(error, data){
			callback(error, data);
		});
	}

	function rotate(args, callback){
		app.api.post('api-token/' + args.id + '/rotate', {}, function(error, data){
			callback(error, data);
		});
	}

	return { list, add, update, remove, rotate };
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

