var app = {};

app.pubsub = (function(){
	app.topics = {};

	app.subscribe = function(topic, listener){
		if(topic instanceof RegExp){
			listener.match = topic;
			topic = "__REGEX__";
		}

		// create the topic if not yet created
		if(!app.topics[topic]) app.topics[topic] = [];

		// add the listener
		app.topics[topic].push(listener);
	}

	app.matchTopics = function(topic){
		topic = topic || '';
		var matches = [... app.topics[topic] ? app.topics[topic] : []];

		if(!app.topics['__REGEX__']) return matches;

		for(var listener of app.topics['__REGEX__']){
			if(topic.match(listener.match)) matches.push(listener);
		}

		return matches;
	}

	app.publish = function(topic, data){

		// send the event to all listeners
		app.matchTopics(topic).forEach(function(listener){
			setTimeout(function(data, topic){
					listener(data || {}, topic);
				}, 0, data, topic);
		});
	}

	return this;
})(app);

app.socket = (function(app){
	// $.getScript('/socket.io/socket.io.js')
	// <script type="text/javascript" src="/socket.io/socket.io.js"></script>
	
	var socket;
	$(document).ready(function(){
		socket = io({
			auth: {
				token: app.auth.getToken()
			}
		});
		// socket.emit('chat message', $('#m').val());
		socket.on('P2PSub', function(msg){
			msg.data.__noSocket	= true;
			app.publish(msg.topic, msg.data);
		});

		app.subscribe(/./g, function(data, topic){
		  // console.log('local_pubs', data, topic)
		  if(data.__noSocket) return;
		  // console.log('local_pubs 2', data, topic)

		  socket.emit('P2PSub', { topic, data });
		});
	})

	return socket;

})(app);

app.api = (function(app){
	var baseURL = '/api/'

	function post(url, data, callback){
		if (!$.isFunction(callback)) {
			return new Promise((resolve, reject) => {
				$.ajax({
					type: 'POST', url: baseURL+url,
					headers: { 'auth-token': app.auth.getToken() },
					data: JSON.stringify(data),
					contentType: 'application/json; charset=utf-8',
					dataType: 'json',
				}).done(resolve).fail(function(xhr){ reject(xhr.responseJSON || {}); });
			});
		}
		return $.ajax({
			type: 'POST',
			url: baseURL+url,
			headers:{ 'auth-token': app.auth.getToken() },
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callback(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				);
			}
		});
	}

	function put(url, data, callback){
		if (!$.isFunction(callback)) {
			return new Promise((resolve, reject) => {
				$.ajax({
					type: 'PUT', url: baseURL+url,
					headers: { 'auth-token': app.auth.getToken() },
					data: JSON.stringify(data),
					contentType: 'application/json; charset=utf-8',
					dataType: 'json',
				}).done(resolve).fail(function(xhr){ reject(xhr.responseJSON || {}); });
			});
		}
		return $.ajax({
			type: 'PUT',
			url: baseURL+url,
			headers:{ 'auth-token': app.auth.getToken() },
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callback(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				);
			}
		});
	}

	function remove(url, callback){
		if (!$.isFunction(callback)) {
			return new Promise((resolve, reject) => {
				$.ajax({
					type: 'DELETE', url: baseURL+url,
					headers: { 'auth-token': app.auth.getToken() },
					contentType: 'application/json; charset=utf-8',
					dataType: 'json',
				}).done(resolve).fail(function(xhr){ reject(xhr.responseJSON || {}); });
			});
		}
		return $.ajax({
			type: 'DELETE',
			url: baseURL+url,
			headers:{ 'auth-token': app.auth.getToken() },
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callback(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				);
			}
		});
	}

	function options(url, callback){
		return $.ajax({
			type: 'OPTIONS',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callback ? callback(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				) : function(){}
			}
		});
	}

	function get(url, callback){
		return $.ajax({
			type: 'GET',
			url: baseURL+url,
			headers:{
				'auth-token': app.auth.getToken()
			},
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			complete: function(res, text){
				callback ? callback(
					text !== 'success' ? res.statusText : null,
					JSON.parse(res.responseText),
					res.status
				) : function(){}
			}
		});
	}

	return {post: post, get: get, put: put, delete: remove, options: options,}
})(app)

app.auth = (function(app){
	var user = {};

	function setToken(token){
		localStorage.setItem('APIToken', token);
	}

	function getToken(){
		return localStorage.getItem('APIToken');
	}

	async function getUser(){
		try{
			return await app.api.get('user/me');
		}catch(error){
			if(error?.status === 401) return null;
			throw error
		}
	}

	async function memberOf(groupNameToFind, user){
		try{
			user = user || await app.auth.asyncUser;
			groupNameToFind = Array.isArray(groupNameToFind) ? groupNameToFind : [groupNameToFind]

			for(let group of user.memberOf){
				group = group.split(',ou=groups')[0].replace('cn=', '');
				if(groupNameToFind.includes(group)) return true;
			}

			return false;

		}catch(error){
			throw(error);
		}
	}

	async function isLoggedIn(){
		if(getToken()){
			user = await app.auth.asyncUser;
			return user;
		}else{
			return false;
		}
	}

	function logIn(args, callback){
		app.api.post('auth/login', args, function(error, data){
			if(data.login){
				setToken(data.token);
			}
			callback(error, !!data.token);
		});
	}

	function logOut(callback){
		localStorage.removeItem('APIToken');
		location.replace(`/login${location.href.replace(location.origin, '')}`);
		callback();
	}

	async function forceLogin(requiredGroups){
		$.holdReady(true);
		if(!await app.auth.isLoggedIn()) app.auth.logOut(function(){});

		if(user.onboardingRequired && location.pathname !== '/onboarding'){
			location.replace('/onboarding');
		}

		if(requiredGroups){
			if(!await memberOf(requiredGroups)){
				console.log("Does not have permission!!!")
				app.util.actionMessage(
					`<h1>
						<i class="fa-solid fa-triangle-exclamation"></i>
						<b>You do not have permission to be here.</b>
						<i class="fa-solid fa-triangle-exclamation"></i>
					</h1>`,
					$('#spa-shell'),
					'danger',
				);
				throw new Error("User does not have permission");
			}
		}

		$.holdReady(false);	
	}

	function logInRedirect(){
		window.location.href = location.href.replace(location.origin+'/login', '') || '/'
	}

	return {
		getToken: getToken,
		setToken: setToken,
		isLoggedIn: isLoggedIn,
		logIn: logIn,
		logOut: logOut,
		forceLogin,
		logInRedirect,
		getUser,
		memberOf,
	}

})(app);
app.auth.asyncUser = app.auth.getUser();


app.user = (function(app){
	function list(callback){
		app.api.get('user/?detail=true', function(error, data){
			callback(error, data);
		})
	}

	function add(args, callback){
		app.api.post('user/', args, function(error, data){
			callback(error, data);
		});
	}

	function remove(args, callback){
		app.api.delete('user/'+ args.username, function(error, data){
			callback(error, data);
		});
	}

	function changePassword(args, callback){
		app.api.put('users/'+ arg.username || '', args, function(error, data){
			callback(error, data);
		});
	}

	return {list, remove};

})(app);

app.util = (function(app){

	function getUrlParameter(name){
		name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
		var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
		var results = regex.exec(location.search);
		return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
	};

	function actionMessage(message, $targetPassed, type, callback){
		message = message || '';

		let $target = $targetPassed.closest('div.card').find('.actionMessage');
		if(!$target.length) $target = $($targetPassed.find('.actionMessage')[0]);

		type = type || 'info';
		callback = callback || function(){};

		if($target.html() === message) return;

		if($target.html()){
			$target.slideUp('fast', function(){
				$target.html('')
				$target.removeClass (function(index, className){
					return (className.match (/(^|\s)bg-\S+/g) || []).join(' ');
				});
				if(message) return actionMessage(message, $target, type, callback);
				$target.hide()
			})
		}else{
			if(type) $target.addClass('bg-' + type);

			if(!message.includes('<button')) message += `
				<button class="action-close btn btn-sm btn-outline-dark float-end">
					<i class="fa-solid fa-xmark"></i>
				</button>
			`
			$target.html(message).slideDown('fast');
		}
		setTimeout(callback,10)
	}

	function actionConfirm(message, $target, type, callback){
		return new Promise((resolve, reject) =>{
			let id = crypto.randomUUID();
			message = `
				<h4 class"align-middle" >
					<i class="fa-solid fa-triangle-exclamation"></i>
					<b>${message}</b>
					<span class="float-end">
						<button type="button" class="btn btn-success confirm-${id}" data-confirm="true">
							<i class="fa-solid fa-circle-check"></i>
							Confirm
						</button>
						<button type="button" class="btn btn-danger confirm-${id}">
							<i class="fa-solid fa-circle-stop"></i>
							Cancel
						</button>
					</span>
				</h4>
			`
			actionMessage(message, $target, type);
			$("body").on('click', `.confirm-${id}`, function(){
				actionMessage('', $target, type);
				resolve(!!$(this).data('confirm'));
			});
		});

	}

	$.fn.serializeObject = function() {
		var obj = {};

		// Get the form values and work over them
		for (let {name, value} of $(this).serializeArray()) {
			console.log(name, value)
			if (obj[name] === undefined) {
				if (!value 
					&& !$(this).parent().find(`[name="${name}"]`).attr('value')
				){
					continue;
				}

				obj[name] = value;

				let type = $(this).parent().find(`[name="${name}"]`).attr('type');
				if (['number', 'range'].includes(type)) {
					obj[name] = Number(value);
				}

				if (['radio'].includes(type) && ['true', 'false'].includes(value)) {
					obj[name] = value == 'true' ? true : false;
				}
			} else {
				if (!(obj[name] instanceof Array)) {
					obj[name] = [obj[name]];
				}
				obj[name].push(value);
			}

		}

		return obj;
	};

	function downloadFile(filename, text){
		// https://stackoverflow.com/a/18197341

		var element = document.createElement('a');
		element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
		element.setAttribute('download', filename);

		element.style.display = 'none';
		document.body.appendChild(element);

		element.click();

		document.body.removeChild(element);
	}

	return {
		downloadFile: downloadFile,
		getUrlParameter: getUrlParameter,
		actionMessage: actionMessage,
		actionConfirm,
	}
})(app);

$( document ).ready(async function(){

	// Show content if the user has the correct group
	for(let group of (await app.auth.asyncUser)?.memberOf || []){
		try{
			group = group.split(',ou=groups')[0].replace('cn=', '');

			const sheet = document.styleSheets[0];
			const selector = `.group-required-${group}`;
			const cssText = `${selector} { display: revert !important; }`;
			sheet.insertRule(cssText, sheet.cssRules.length);
		}catch(error){
			
		}
	}

	$('div.row').fadeIn('slow'); //show the page

	//panel button's
	$('.fa-arrows-v').click(function(){
		$(this).closest('.card').find('.card-body').slideToggle('fast');
	});

	$('.fa-circle-minus').click(function(){
		let $body = $(this).closest('.card').find('.card-body');
		if($body.hasClass('d-none')){
			$body.removeClass("d-none").removeClass('d-md-block');
			if($body.is(":visible")) $body.hide();
		}
		$body.slideToggle('fast');
	});

	$('.fa-circle-xmark').click(function(){
		$(this).closest('.card').slideUp('fast');
	});

	$('.actionMessage').on('click', 'button.action-close', function(event){
		app.util.actionMessage(null, $(this));
	});

	setInterval(()=>{
		$('.momentFromNow').each((idx, el)=>{
			var $el = $(el);
			try{
				$el.html(moment($(el).data('date')).fromNow());
			}catch{}
		})
	}, 30000,);
});

(function($){
	$.fn.scrollTo = function(){
		const yOffset = Number($('#spa-shell').css('margin-top').replace('px', ''));
		const y = this[0].getBoundingClientRect().top + window.scrollY - yOffset;

		console.log('y', y)
		window.scrollTo({top: y, behavior: 'smooth'});
	};

})(jQuery);

//ajax form submit
function formAJAX(btn){
	event.preventDefault(btn); // avoid to execute the actual submit of the form.
	var $form = $(btn || event.target).closest('[action]'); // gets the 'form' parent
	var formData = $form.find('[name]').serializeObject(); // builds query formDataing
	var method = ($form.attr('method') || 'post').toLowerCase();

	if($form.validate && !$form.validate()){
		app.util.actionMessage('Please fix the form errors.', $form, 'danger')
		return false;
	}
	
	app.util.actionMessage( 
		`<div class="spinner-border" role="status">
			<span class="visually-hidden">Loading...</span>
		</div>`,
		$form,
		'info'
	);

	app.api[method]($form.attr('action'), formData, function(error, data){
		app.util.actionMessage(data.message, $form, error ? 'danger' : 'success'); //re-populate table
		$form.validateClear();
		if(!error){
			$form.trigger("reset");
			eval($form.attr('evalAJAX')); //gets JS to run after completion
		}else{
			console.log('formAJAX res error', error, data)
			if(data && data.name === 'ObjectValidateError'){
				app.util.actionMessage('Please fix the form errors', $form, 'danger'); //re-populate table
			}
			if(data && data.keys){
				console.log('form key errors', data.keys)
				for(let keyError of data.keys){
					$form.find(`[name=${keyError.key}]`).validateMessage(keyError.message);
				}
			}
		}
	});
}

