/*
 * Show Ip menu gnome extension
 * https://github.com/sgaraud/
 *
 */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const St = imports.gi.St;
const GObject = imports.gi.GObject;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const NMC = imports.gi.NMClient;
const NetworkManager = imports.gi.NetworkManager;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

// Used to request via HTTP the public address to a server.
const Soup = imports.gi.Soup;
const _httpSession = new Soup.SessionAsync();
// This makes the session work under a proxy. The funky syntax here
// is required because of another libsoup quirk, where there's a gobject
// property called 'add-feature', designed as a construct property for
// C convenience.
Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

// Setup to make the Preferences button in the PopupMenu open directly
// the prefs GUI.
const Shell = imports.gi.Shell;
let _appSys = Shell.AppSystem.get_default();
let _gsmPrefs = _appSys.lookup_app('gnome-shell-extension-prefs.desktop');
let metadata = Me.metadata;

const NOT_CONNECTED = 'not connected'
const NM_NOT_RUNNING = 'NM not running'

function init() {
   Schema = Convenience.getSettings();
}

const IpDevice = new Lang.Class({ 
   Name: 'IpDevice.IpDevice',
   _init: function (obj) {
      this.device = obj;
      this.ifc = obj.get_iface();
      this.ipconf = obj.get_ip4_config();
      this.ip = NOT_CONNECTED;
      this._stateChangedId = null;
      this._ipConfId = null;
      this.activated= false;
   },
});

const IpMenu = new Lang.Class({
   Name: 'IpMenu.IpMenu',
   Extends: PanelMenu.Button,

   _init: function() {

      this.nmStarted = true;

      this.selectedDevice = null;
      if (Schema.get_string('last-device') != '')
         this.selectedDevice = Schema.get_string('last-device');

      this.parent(0.0, _("Show IP"));

      let nbox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

      this.label = new St.Label({ text: '',
                                  y_expand: true,
                                  y_align: Clutter.ActorAlign.CENTER });

      nbox.add_child(this.label);
      this.actor.add_child(nbox);

      this.label.set_text(NOT_CONNECTED);
      this.client = NMC.Client.new();

      if (this.client.get_manager_running() == false) {
         this.label.set_text(NM_NOT_RUNNING);
         this.nmStarted = false;
         return;
      }

      this._clientAddedId = this.client.connect('device-added', Lang.bind(this,this._deviceAdded));
      this._clientRemovedId = this.client.connect('device-removed', Lang.bind(this,this._deviceRemoved));
      this._getNetworkDevices(this.client);
      this._updateMenuVisibility();
   },

   _updateMenuVisibility: function() {
      this.actor.show();
   },

   _deviceAdded: function(client,device) {
      let _device;
      _device = new IpDevice(device);
      _device._stateChangedId = device.connect('state-changed',Lang.bind(this,this._updateIp));
      this._devices.push(_device);
      this._updateIp(device);
   },

   _deviceRemoved: function(client,device) {
      for (let dev of this._devices) {
         if (dev.device == device) {
	    this._resetDevice(dev);
	    if (this.selectedDevice == dev.ifc) {
	       this.selectedDevice = null;
	       this.label.set_text(NOT_CONNECTED);
	    }
	    let index = this._devices.indexOf(dev);
	    if (index > -1) {
	       this._devices.splice(index, 1);
	    }
	    this._createPopupMenu();
	    break;
         }
      }
   },

   _createPopupMenu: function() {
      this.menu.removeAll();
      for (let device of this._devices) {
         if (device.activated== true){
	    this._addToPopupMenu(device.ifc);
         }
      }
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      //this.item = new PopupMenu.PopupMenuItem(_("Copy IP"));
      this.item = new PopupMenu.PopupMenuItem(_("Preferences"));
      this.menu.addMenuItem(this.item);
      this.item.connect('activate', function () {
         if (_gsmPrefs.get_state() == _gsmPrefs.SHELL_APP_STATE_RUNNING){
	    _gsmPrefs.activate();
         } else {
	    let info = _gsmPrefs.get_app_info();
	    let timestamp = global.display.get_current_time_roundtrip();
	    info.launch_uris([metadata.uuid], global.create_app_launch_context(timestamp, -1));
         }
      });
   },

   _addToPopupMenu: function(dev) {
      this.item = new PopupMenu.PopupMenuItem(dev);
      this.menu.addMenuItem(this.item);
      this._manualUpdateId = this.item.connect('activate', Lang.bind(this,this._manualUpdate));
   },

   _manualUpdate: function(it) {
      for (let device of this._devices) {
	 if (device.ifc == it.label.get_text()){
	    this.selectedDevice = device.ifc;
	    Schema.set_string('last-device',device.ifc);
	    this.label.set_text(device.ip);
	    break;
	 }
      }
      this._setPublic();
   },

   _getNetworkDevices: function(nmc) {
      let _device;
      this.devices = nmc.get_devices();
      this._devices = [];
      let i = 0;
      for (let device of this.devices) {
	  _device = new IpDevice(device);
	  _device._stateChangedId = device.connect('state-changed',Lang.bind(this,this._updateIp));
	  this._devices[i++] = _device;
	  this._updateIp(device);
      }
   },

   _updateIp: function(dev) {
      let ipconf = dev.get_ip4_config();
      if (Schema.get_boolean('ipv6'))
	 ipconf = dev.get_ip6_config();
      let ifc = dev.get_iface();

      if (ipconf != null && dev.get_state() == NetworkManager.DeviceState.ACTIVATED) {
	 this._addInterface(ipconf,ifc);
      }
      else{
	 this._deleteInterface(ifc);
      }
   },

   _addInterface: function(ipconf, ifc) {
      for (let device of this._devices){
	 if (device.ifc == ifc){

	    if (device._ipConfId != null) {
	       device.ipconf.disconnect(device._ipConfId);
	       device._ipConfId = null;
	    }

	    device.activated= true;
	    device.ipconf = ipconf;

	    if (typeof(device.ipconf.get_addresses()[0]) == 'undefined') {
	       device._ipConfId = ipconf.connect('notify::addresses',Lang.bind(this,function(){
		  ipconf.disconnect(device._ipConfId);
		  device._ipConfId = null;
		  if (typeof(device.ipconf.get_addresses()[0]) != 'undefined') {
		     this._getIp4s(ipconf.get_addresses()[0].get_address(),ifc);
		  }
		  // tweak to catch possible buffered notification
		  else {
		     this._getIp4s(0,ifc);
		  }
	       }));
	    }
	    else {
	       this._getIp4s(ipconf.get_addresses()[0].get_address(),ifc);
	    }
	    break;
	 }
      }
   },

   _deleteInterface: function (ifc) {

      for (let device of this._devices) {
	 if (device.ifc == ifc) {
	    device.activated= false;

	    if (this.selectedDevice == device.ifc) {
	       this.selectedDevice = null;

	       for (let dev of this._devices) {
		  if (dev.activated == true) {
		     this.selectedDevice = dev.ifc;   
		     this.label.set_text(dev.ip);
		     break;
		  }
		  else{
		     this.label.set_text(NOT_CONNECTED);
		  }
	       }
	    }
	    break;
	 }
      }

      this._createPopupMenu();
   },

   _getIp4s: function (ipadd,ifc) {

      // get a boolean if remembered device still exists or not
      let found = false;
      for (let device of this._devices) {
	 if (this.selectedDevice == device.ifc)
	    found = true;
      }

      // iterate until current device found in list
      for (let device of this._devices) {
	 if(device.ifc == ifc) {
	    // populate the device 'ip' field
	    if (Schema.get_boolean('ipv6')){
	       device.ip = this._decodeIp6(ipadd);
	    } else {
	       device.ip = this._decodeIp4(ipadd);
	    }

	    // SPECIAL CASE for device rememberance ability
	    if (!found) {
	       this.selectedDevice = device.ifc;
	       this.label.set_text(device.ip);
	    } else if (this.selectedDevice == ifc) {
	       this.label.set_text(device.ip);
	    }
	    break;
	 }
      }
      this._setPublic();
      this._createPopupMenu();
   },

   _decodeIp4: function(num) {
      num = num>>>0;
      let array = Uint8Array(4);
      array[0] = num;
      array[1] = num >> 8;
      array[2] = num >> 16;
      array[3] = num >> 24;

      return array[0]+'.'+array[1]+'.'+array[2]+'.'+array[3];
   },

   // inspired from http://phpjs.org/functions/inet_ntop/
   _decodeIp6: function(num) {
      var c = [];
      var m = '';
      for (i = 0; i < 16; i=i+2) {
	 c.push(num[i].toString(16) + num[i+1].toString(16));
      }
      return c.join(':')
	 .replace(/((^|:)0*(?=:|$))+:?/g, function(t) {
            m = (t.length > m.length) ? t : m;
	    return t;
	 })
	 .replace(m || ' ', '::');
   },

   _getPublic: function(callback) {
      let request = Soup.Message.new('GET','http://ipinfo.io/ip');
      
      _httpSession.queue_message(request, function(_httpSession, message) {
	 if (message.status_code !== 200) {
	    callback(message.status_code, null);
	    return;
	 }
	 let ip = request.response_body.data;
	 callback(null, ip);
      });
   },

   _setPublic: function() {
      if (Schema.get_boolean('public')){
	 let that = this.label;  
	 this._getPublic(function(err,res){
	    that.set_text(res.trim());
	 });
      }
   },

   _resetDevice: function(device) {
      GObject.Object.prototype.disconnect.call(device.device,device._stateChangedId);
      if (device._ipConfId != null) {
	 GObject.Object.prototype.disconnect.call(device.ipconf,device._ipConfId);
      }
   },

   destroy: function() {
      this.parent();
      if (this.nmStarted == true) {
	 for (let device of this._devices) {
	    this._resetDevice(device);
	 }
	 this._devices=[];
	 this.client.disconnect(this._clientAddedId);
	 this.client.disconnect(this._clientRemovedId);
	 this.item.disconnect(this._manualUpdateId);
      }
   },
});

let _indicator;

function enable() {
   _indicator = new IpMenu;
   Main.panel.addToStatusArea('Ip-menu', _indicator);
}

function disable() {
   _indicator.destroy();
}
