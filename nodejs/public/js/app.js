var app = {};

app.api = (function(app){
	var baseURL = '/api/'

	function post(url, data, callack){
		$.ajax({
			type: 'POST',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callack(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				)
			}
		});
	}

	function put(url, data, callack){
		$.ajax({
			type: 'PUT',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callack(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				)
			}
		});
	}

	function remove(url, callack, callack2){
		if(!$.isFunction(callack)) callack = callack2;
		$.ajax({
			type: 'delete',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callack(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				)
			}
		});
	}

	function get(url, callack){
		$.ajax({
			type: 'GET',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callack(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				)
			}
		});
	}

	return {post: post, get: get, put: put, delete: remove}
})(app)

app.auth = (function(app) {
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
		app.api.get('user/?detail=true', function(error, data){
			callack(error, data);
		})
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

	return {list, remove, createInvite};

})(app);

app.host = (function(app){
	function list(callack){
		app.api.get('host/?detail=true', function(error, data){
			callack(error, data.hosts)
		});
	}

	function get(host, callack){
		app.api.get('host/' + host, function(error, data){
			callack(error, data)
		});
	}

	function add(args, callack){
		app.api.post('host/', args, function(error, data){
			callack(error, data);
		});
	}

	function edit(args, callack){
		app.api.put('host/' + args.edit_host, args, function(error, data){
			callack(error, data);
		});
	}

	function remove(args, callack){
		app.api.delete('host/'+ args.host, function(error, data){
			callack(error, data);
		})
	}

	return {
		list: list,
		get: get,
		add: add,
		edit: edit,
		remove: remove,
	}
})(app);

app.group = (function(app){
	function list(callack){
		app.api.get('group?detail=true', function(error, data){
			callack(error, data);
		});
	}

	function remove(args, callack){
		app.api.delete('group/'+args.cn, function(error, data){
			callack(error, data);
		});
	}

	return {list, remove}
})(app)

app.token = (function(app){
	function list(name, callack){
		if($.isFunction(name)){
			callack = name;
			name = ''
		}
		app.api.get('token/'+name+'?detail=true', function(error, data){
			callack(error, data);
		});
	}

	return {list}
})(app)

app.util = (function(app){

	function getUrlParameter(name) {
	    name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
	    var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
	    var results = regex.exec(location.search);
	    return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
	};

	function actionMessage(message, $target, type){
		message = message || '';
		$target = $($target.closest('div.card').find('.actionMessage')[0]);
		type = type || 'info';

		if($target.html() === message) return;

		if($target.html()){
			$target.slideUp('fast', function(){
				$target.html('')
				$target.removeClass (function (index, className) {
					return (className.match (/(^|\s)bg-\S+/g) || []).join(' ');
				});
				if(message) actionMessage(message, $target, type);
			})
			return;
		}else{
			if(type) $target.addClass('bg-' + type);
			$target.html(message).slideDown('fast');
		}
	}

	$.fn.serializeObject = function() {
	    var 
	        arr = $(this).serializeArray(), 
	        obj = {};
	    
	    for(var i = 0; i < arr.length; i++) {
	        if(obj[arr[i].name] === undefined) {
	            obj[arr[i].name] = arr[i].value;
	        } else {
	            if(!(obj[arr[i].name] instanceof Array)) {
	                obj[arr[i].name] = [obj[arr[i].name]];
	            }
	            obj[arr[i].name].push(arr[i].value);
	        }
	    }
	    return obj;
	};

	return {
		getUrlParameter: getUrlParameter,
		actionMessage: actionMessage
	}
})(app);

$.holdReady( true );
if(!location.pathname.includes('/login')){
	app.auth.isLoggedIn(function(error, isLoggedIn){
		if(error || !isLoggedIn){
			app.auth.logOut(function(){})
			location.replace('/login/?redirect='+location.pathname);
		}else{
			$.holdReady( false );
		}
	})
}else{
	$.holdReady( false );
}

$( document ).ready( function () {

	$( 'div.row' ).fadeIn( 'slow' ); //show the page

	//panel button's
	$( '.fa-arrows-v' ).click( function () {
		$( this ).closest( '.card' ).find( '.card-body' ).slideToggle( 'fast' );
	});


	$( '.glyphicon-refresh' ).each( function () {
		$(this).click( function () {
			tableAJAX();
		});
	});
});

//ajax form submit
function formAJAX( btn, del ) {
	event.preventDefault(); // avoid to execute the actual submit of the form.
	var $form = $(btn).closest( '[action]' ); // gets the 'form' parent
	var formData = $form.find( '[name]' ).serializeObject(); // builds query formDataing
	var method = $form.attr('method') || 'post';

	if( !$form.validate()) {
		app.util.actionMessage('Please fix the form errors.', $form, 'danger')
		return false;
	}
	
	app.util.actionMessage( 
		'<div class="spinner-border" role="status"><span class="sr-only">Loading...</span></div>',
		$form,
		'info'
	);

	app.api[method]($form.attr('action'), formData, function(error, data){
		app.util.actionMessage(data.message, $form, error ? 'danger' : 'success'); //re-populate table
		if(!error){
			$form.trigger("reset");
			eval($form.attr('evalAJAX')); //gets JS to run after completion
		}
	});

}
