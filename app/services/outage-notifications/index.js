const consumer = require('./consumer');
const rules = require('./rules');
const templates = require('./templates');
const delivery = require('./delivery');
const preferences = require('./preferences');

module.exports = {
  ...consumer,
  ...rules,
  ...templates,
  ...delivery,
  ...preferences,
};
