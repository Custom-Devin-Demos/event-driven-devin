'use strict';

var handlebars = require('handlebars');

handlebars.registerHelper('skuList', function (skus) {
  return skus.map(function (sku) {
    return '<li class="sku">' + sku + '</li>';
  }).join('');
});

var TEMPLATE = handlebars.compile([
  '<section class="picking-note">',
  '  <h1>Priority replenishment — {{generatedAt}}</h1>',
  '  <ul>{{{skuList skus}}}</ul>',
  '</section>',
].join('\n'));

module.exports = function renderPickingNote(context) {
  return TEMPLATE(context);
};
