const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../app/public/alert-destination.js'), 'utf8');

function createAlertDestination(initialStorage = {}) {
  const values = new Map(Object.entries(initialStorage));
  const localStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  const document = {
    cookie: '',
    getElementById() {
      return null;
    },
    createElement(tagName) {
      return createMockElement(tagName);
    },
    createTextNode(text) {
      return { textContent: String(text) };
    },
    head: {
      appendChild() {},
    },
  };
  const window = {
    addEventListener() {},
  };
  const context = { document, location: { protocol: 'https:' }, localStorage, window };
  vm.runInNewContext(source, context, { filename: 'alert-destination.js' });
  return { document, localStorage, api: window.AlertDestination };
}

function createMockElement(tagName) {
  return {
    tagName,
    children: [],
    classList: {
      toggle() {},
    },
    appendChild(node) {
      this.children.push(node);
    },
    set textContent(value) {
      this._textContent = String(value);
      this.children = [];
    },
    get textContent() {
      return this._textContent || this.children.map((node) => node.textContent || '').join('');
    },
  };
}

function createPicker() {
  const buttons = ['slack', 'teams'].map((value) => {
    const attributes = {};
    const handlers = {};
    return {
      attributes,
      handlers,
      classList: {
        toggle() {},
      },
      children: [],
      getAttribute(name) {
        return name === 'data-value' ? value : null;
      },
      setAttribute(name, content) {
        attributes[name] = content;
      },
      addEventListener(name, handler) {
        handlers[name] = handler;
      },
      appendChild(node) {
        this.children.push(node);
      },
      focus() {},
    };
  });
  const title = createMockElement('div');
  const summary = createMockElement('div');
  summary.innerHTML = '';
  summary.classList = { toggle() {} };
  Object.defineProperty(summary, 'innerHTML', {
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = value;
      this.children = [];
    },
  });
  return {
    buttons,
    summary,
    title,
    element: {
      set innerHTML(value) {
        this.html = value;
      },
      querySelectorAll() {
        return buttons;
      },
      querySelector(selector) {
        return selector === '.adp-title' ? title : summary;
      },
    },
  };
}

describe('browser alert destination defaults', () => {
  test('uses a page-scoped Teams default without persisting it', () => {
    const runtime = createAlertDestination();
    const picker = createPicker();

    runtime.api.mount(picker.element, { defaultValue: 'teams' });

    expect(runtime.api.get()).toBe('teams');
    expect(runtime.localStorage.getItem('alertDestination')).not.toBe('teams');
    expect(runtime.document.cookie).not.toContain('alert_destination=teams');
    expect(picker.buttons[1].attributes['aria-checked']).toBe('true');

    picker.buttons[0].handlers.click();
    expect(runtime.api.get()).toBe('slack');
    expect(runtime.localStorage.getItem('alertDestination')).toBe('slack');
    expect(runtime.localStorage.getItem('alertDestinationExplicit')).toBe('1');
    expect(runtime.document.cookie).toContain('alert_destination=slack');
  });

  test('an explicit stored choice overrides the page default', () => {
    const runtime = createAlertDestination({
      alertDestination: 'slack',
      alertDestinationExplicit: '1',
    });
    const picker = createPicker();

    runtime.api.mount(picker.element, { defaultValue: 'teams' });

    expect(runtime.api.get()).toBe('slack');
    expect(picker.buttons[0].attributes['aria-checked']).toBe('true');
  });

  test('does not use a Teams page default when Teams is unavailable', () => {
    const runtime = createAlertDestination();
    const picker = createPicker();

    runtime.api.mount(picker.element, { defaultValue: 'teams', teamsAvailable: false });

    expect(runtime.api.get()).toBe('slack');
    expect(runtime.localStorage.getItem('alertDestination')).not.toBe('teams');
    expect(picker.buttons[1].attributes['aria-checked']).toBe('false');
  });

  test('escapes custom labels while preserving bold summary text', () => {
    const runtime = createAlertDestination();
    const picker = createPicker();

    runtime.api.mount(picker.element, {
      labels: {
        title: '<img src=x onerror="alert(1)">',
        slack: '<img src=x>',
        slackSelected: 'Alerts <b>Slack</b> <img src=x>',
      },
    });

    expect(picker.element.html).not.toContain('<img');
    expect(picker.title.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(picker.buttons[0].children[0].textContent).toBe('<img src=x>');
    expect(picker.summary.children[0].children.some((node) => node.tagName === 'b' && node.textContent === 'Slack')).toBe(true);
    expect(picker.summary.children[0].children.map((node) => node.textContent).join('')).toContain('<img src=x>');
    expect(picker.summary.children[0].children.some((node) => node.tagName === 'img')).toBe(false);
  });
});
