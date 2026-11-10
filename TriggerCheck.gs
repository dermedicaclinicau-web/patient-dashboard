// Run from the editor: lists every trigger in this project
function listTriggers() {
  const all = ScriptApp.getProjectTriggers();
  const count = {};
  all.forEach(function (t) {
    const h = t.getHandlerFunction();
    count[h] = (count[h] || 0) + 1;
    console.log(h + ' · ' + t.getEventType() + ' · ' + t.getTriggerSource());
  });
  console.log(all.length + ' of 20 triggers used.');
  Object.keys(count).forEach(function (h) {
    if (count[h] > 1) console.log('⚠ ' + h + ' has ' + count[h] + ' triggers (usually only one is needed)');
  });
}