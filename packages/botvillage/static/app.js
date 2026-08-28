(function () {
  'use strict';

  var root = document.getElementById('app');
  var api = window.Botvillage.mount(root, {
    onSelect: function () {},
  });

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg && msg.type === 'world' && msg.world) api.setWorld(msg.world);
        if (msg && msg.type === 'activity' && msg.world) api.setWorld(msg.world);
      } catch (_) {}
    };
    ws.onclose = function () {
      setTimeout(connect, 1500);
    };
  }

  fetch('/api/bots')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.world) api.setWorld(data.world);
    })
    .catch(function () {});

  connect();
})();
