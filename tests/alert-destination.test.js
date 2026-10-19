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
    createElement() {
      return {};
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
      getAttribute(name) {
        return name === 'data-value' ? value : null;
      },
      setAttribute(name, content) {
        attributes[name] = content;
      },
      addEventListener(name, handler) {
        handlers[name] = handler;
      },
      focus() {},
    };
  });
  const summary = {
    classList: {
      toggle() {},
    },
  };
  return {
    buttons,
    element: {
      set innerHTML(value) {
        this.html = value;
      },
      querySelectorAll() {
        return buttons;
      },
      querySelector() {
        return summary;
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
    expect(runtime.localStorage.getItem('alertDestination')).toBeNull();
    expect(runtime.document.cookie).toBe('');
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
    expect(runtime.localStorage.getItem('alertDestination')).toBeNull();
    expect(picker.buttons[1].attributes['aria-checked']).toBe('false');
  });
});
