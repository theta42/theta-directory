( function( $ ) {
	var settings = {
		rule: {
			eq: function( value, options ) {
				var compare = $( '[name=' + options + ']' ).val();
	 
				if ( value != compare ) {
					return "Miss-match";
				}
			}
		},

		form: {
			alertCount: false, //pop-up with error count
			alertCountMessage: " errors!"
		},
		
		processValidation: function ( error_message, $input ) {
			if ( typeof error_message == 'undefined' || error_message == true ) {
				return;
			}

			$( '<b style="color:#dc3545" class="jvalidate-error">' ).html( ' - ' + error_message ).appendTo( $input.parents('.form-group').children( 'label' ) );
			$input.addClass("is-invalid");
			failedCount++;
			return false;
		}
	};

	var failedCount = 0;

	function processRule( thisSettings, $input ) {
		var attr = $input.attr( 'validate' ).split( ':' ), //array of params
			requirement = attr[1],
			value = $input.val(), //link to input value
			rule = attr[0];

		$input.parents('.form-group').children( 'label' ).children( '.jvalidate-error' ).remove(); //removes old error
		$input.removeClass( "is-invalid" ); //removes is-invalid class

		//checks if field is required, and length 
		if (isNaN(requirement) === false && requirement && value.length < requirement) {
			return thisSettings.processValidation( 'Must be ' + requirement + ' characters', $input );
		}

		//checks if empty to stop processing 
		if ( isNaN( requirement ) === false && value.length === 0 ) {
			return;
		}

		if ( rule in thisSettings.rule ) {
			return thisSettings.processValidation( thisSettings.rule[rule].apply( this, [value, requirement] ), $input );
		}
	}
		
	$.fn.validate = function( settingsObj, event ) {
		event = event || window.event;
		
		failedCount = 0;
		var thisForm = false,
			thisSettings = $.extend( true, settings, settingsObj );

		if ( this.is( '[validate]' ) ) {
			processRule( thisSettings, this );
		} else {
			thisForm = true;
			this.find( '[validate]' ).each( function () {
				if(!processRule( thisSettings, $( this ) )){
					// failedCount++;
				}
			});
		}

		this.attr('isValid', !failedCount);
		if ( failedCount === 0 ) { //no errors
			return true;
		} else { //errors
			if ( thisForm ){
				if(thisSettings.form.alertCount){
					alert( failedCount + thisSettings.form.alertCountMessage );
				}
				/* if(event) event.returnValue = false;
				if(event) event.preventDefault();
				return false;
				
				if(event.preventDefault) if(event)*/ 
				//event.returnValue = false;
				event.preventDefault();
				event.defaultPrevented;

			}
			return false;
		}
	};

	jQuery.extend({
		validateSettings: function( settingsObj ) {
			$.extend( true, settings, settingsObj );
		},

		validateInit: function( ettingsObj ) {
			$( '[action]' ).on( 'submit', function ( event, settingsObj ){
				$( this ).validate( settingsObj, event );
			});
		}
	});

}( jQuery ));

$.validateSettings({
	rule:{
		ip: function( value ) {
			value = value.split( '.' );
 
			if ( value.length != 4 ) {
				return "Malformed IP";
			}
 
			$.each( value, function( key, value ) {
				if( value > 255 || value < 0 ) {
					return "Malformed IP";
				}
			});
		},

		host: function( value ) {
			var reg = /^(?=.{1,255}$)[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?(?:\.[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?)*\.?$/;
			if ( reg.test( value ) === false ) {
				return "Invalid";
			}
		},

		user: function( value ) {
			var reg = /^[a-z0-9\_\-\@\.]{1,32}$/;
			if ( reg.test( value ) === false ) {
				return "Invalid";
			}
		},
 
		password: function( value ) {
			var reg = /^(?=[^\d_].*?\d)\w(\w|[!@#$%]){1,48}/;
			if ( reg.test( value ) === false ) {
				return "Weak password, Try again";
			}
		},
		email: function( value ){

			//validated email address
			//more testing
			var pattern = new RegExp(/^((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)((((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*(((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?$/i);
				if( !pattern.test( value ) ){
					return 'Invalid';
				}
		},
	}
});