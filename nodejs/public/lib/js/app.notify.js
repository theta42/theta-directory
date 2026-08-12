/* Notifications: the bell, the feed, and desktop notifications.
 *
 * There is no separate notification stream. Every model event the server
 * decided you may see is a notification — the socket read gate already made
 * that decision, live and per row — so this listens to the same events the
 * views do and renders them.
 *
 * History is the same events replayed through the same gate (GET /api/activity),
 * and "unread" is one watermark per user rather than a read flag per item, so
 * opening the bell on one device clears the badge on all of them.
 */

(function($){
	'use strict';

	window.app = window.app || {};

	// How long two events of the same model+action stay collapsed together.
	// A discovery sweep writes hundreds of resources; the feed should say
	// "203 resources updated", not scroll for a minute.
	const COLLAPSE_WINDOW_MS = 60 * 1000;

	// Where a notification takes you. The stored event is shape only —
	// model + pk — which is exactly enough to build a link, provided the target
	// page can open a record from its pk.
	const LINKS = {
		Resource:       (pk) => '/directory/' + encodeURIComponent(pk),
		ResourceGroup:  ()   => '/directory',
		ResourceEdge:   ()   => '/directory',
		PluginInstance: ()   => '/directory',
		Agent:          ()   => '/directory',
		User:           (pk) => '/users/' + encodeURIComponent(pk),
		Group:          ()   => '/users',
		MeshClient:     ()   => '/network',
		MeshSite:       ()   => '/network',
		MeshExitGrant:  ()   => '/network',
		AccessRequest:  ()   => '/',
		Notification:   ()   => '/overview',
		ApiToken:       ()   => '/profile',
	};

	// Human wording. "Something was added over here" is the whole brief, so a
	// generic sentence built from model + action covers every model, including
	// ones added later that nobody remembered to write copy for.
	const VERBS = {create: 'added', update: 'updated', delete: 'removed'};

	function label(model){
		// CamelCase -> spaced words, lowercased: MeshExitGrant -> mesh exit grant
		return String(model).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	}

	// A pk is only worth showing when it means something to a person. Host and
	// User are keyed on the hostname and the uid, which read well; Resource and
	// friends are keyed on a UUID, which is pure noise in a sentence. Shape-only
	// history has no display name to fall back on, so say nothing rather than
	// show a UUID — the link still takes you to the record.
	function readableTarget(target){
		if (!target) return '';
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) return '';
		if (/^[0-9a-f]{16,}$/i.test(target)) return '';
		return target;
	}

	function describe(group){
		const verb = VERBS[group.action] || group.action;
		if (group.count > 1) return group.count + ' ' + label(group.model) + 's ' + verb;
		const target = readableTarget(group.target);
		return label(group.model) + ' ' + verb + (target ? ': ' + target : '');
	}

	function linkFor(group){
		const build = LINKS[group.model];
		// Only link a single record — a collapsed group has no one target.
		if (!build || group.count > 1) return build ? build('') : null;
		return build(group.target);
	}

	// Collapse a time-ordered (newest first) event list into display groups.
	function collapse(events){
		const groups = [];
		for (const e of events) {
			const last = groups[groups.length - 1];
			const sameKind = last && last.model === e.model && last.action === e.action;
			const closeInTime = last && Math.abs(Number(last.oldest) - Number(e.created_on)) < COLLAPSE_WINDOW_MS;
			if (sameKind && closeInTime) {
				last.count++;
				last.oldest = e.created_on;
				continue;
			}
			groups.push({
				model: e.model,
				action: e.action,
				target: e.target,
				actor: e.actor,
				count: 1,
				created_on: e.created_on,
				oldest: e.created_on,
			});
		}
		return groups;
	}

	app.notify = {
		events: [],
		unread: 0,
		seenAt: 0,

		// ── desktop notifications ────────────────────────────────────────────
		// Permission is only ever requested from a click (browsers ignore or
		// penalise unprompted requests, and a permission bubble on page load is
		// hostile). Nothing here fires while the tab is focused — you are
		// already looking at the page that just updated itself.
		desktopAvailable: function(){
			return typeof window.Notification !== 'undefined';
		},

		desktopEnabled: function(){
			return this.desktopAvailable() && window.Notification.permission === 'granted';
		},

		requestDesktop: function(){
			if (!this.desktopAvailable()) return Promise.resolve('unsupported');
			if (window.Notification.permission !== 'default') {
				return Promise.resolve(window.Notification.permission);
			}
			return window.Notification.requestPermission();
		},

		showDesktop: function(group){
			if (!this.desktopEnabled()) return;
			if (!document.hidden) return;
			try {
				const url = linkFor(group);
				const note = new window.Notification(describe(group), {
					body: group.actor ? 'by ' + group.actor : undefined,
					// Same tag replaces rather than stacks, so a burst of one
					// kind shows as a single desktop notification.
					tag: 'theta-' + group.model + ':' + group.action,
					renotify: false,
				});
				note.onclick = function(){
					window.focus();
					if (url) window.location.href = url;
					note.close();
				};
			} catch (error) {
				// Never let a notification break the page.
				console.error('desktop notification failed', error);
			}
		},

		// ── feed ─────────────────────────────────────────────────────────────
		load: function(){
			return $.when(app.api.get('activity')).done(function(data){
				app.notify.events = (data && data.results) || [];
				app.notify.unread = (data && data.unread) || 0;
				app.notify.seenAt = (data && data.seen_at) || 0;
				app.notify.render();
			});
		},

		// An event arrived over the socket: it is, by definition, one you may
		// see — the server already applied the gate to send it.
		push: function(payload){
			if (!payload || !payload.model) return;
			const event = {
				model: payload.model,
				action: payload.action,
				target: payload.pk === undefined || payload.pk === null ? '' : String(payload.pk),
				actor: (payload.data && (payload.data.updated_by || payload.data.created_by)) || '',
				created_on: Date.now(),
			};
			this.events.unshift(event);
			this.unread++;
			this.render();
			this.showDesktop(collapse([event])[0]);
		},

		markSeen: function(){
			const seen_at = Date.now();
			this.seenAt = seen_at;
			this.unread = 0;
			this.render();
			app.api.put('activity/seen', {seen_at});
		},

		render: function(){
			const $badge = $('#notify-badge');
			if ($badge.length) {
				$badge.text(this.unread > 99 ? '99+' : this.unread).toggle(this.unread > 0);
			}

			const $list = $('#notify-list');
			if (!$list.length) return;

			const groups = collapse(this.events).slice(0, 30);
			if (!groups.length) {
				$list.html('<li class="px-3 py-4 text-center text-muted small">Nothing yet.</li>');
				return;
			}

			$list.empty();
			groups.forEach(function(group){
				const url = linkFor(group);
				const unread = Number(group.created_on) > app.notify.seenAt;
				const when = window.moment ? moment(Number(group.created_on)).fromNow() : '';
				const $item = $('<li>').append(
					$('<a>')
						.addClass('dropdown-item d-flex align-items-start gap-2 py-2')
						.toggleClass('fw-semibold', unread)
						.attr('href', url || '#')
						.append(
							$('<span>').addClass('small').text(describe(group)),
							$('<span>').addClass('ms-auto text-muted small text-nowrap').text(when)
						)
				);
				$list.append($item);
			});
		},

		init: function(){
			if (!$('#notify-bell').length) return;

			this.load();

			// The same events the views react to. No separate stream.
			app.subscribe(/^model:/, function(data){
				app.notify.push(data);
			});

			$('#notify-bell').on('show.bs.dropdown', function(){
				app.notify.markSeen();
			});

			$('#notify-desktop-toggle').on('click', function(e){
				e.preventDefault();
				e.stopPropagation();
				app.notify.requestDesktop().then(function(state){
					app.notify.renderDesktopToggle(state);
				});
			});

			this.renderDesktopToggle(this.desktopAvailable() ? window.Notification.permission : 'unsupported');
		},

		renderDesktopToggle: function(state){
			const $t = $('#notify-desktop-toggle');
			if (!$t.length) return;
			if (state === 'granted') $t.text('Desktop notifications on').addClass('text-success');
			else if (state === 'denied') $t.text('Desktop notifications blocked').addClass('text-muted');
			else if (state === 'unsupported') $t.hide();
			else $t.text('Enable desktop notifications');
		},
	};

	$(function(){ app.notify.init(); });

})(jQuery);
