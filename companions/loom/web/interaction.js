(() => {
  const title = document.querySelector('body > h1');
  const form = document.getElementById('submitForm');
  const received = document.querySelector('body > .ok');
  if (!title || (!form && !received) || !title.textContent.startsWith('Loom:')) return;
  const approval = title.textContent.includes('approval');
  document.documentElement.lang = 'en';
  document.body.classList.add('loom-interaction');
  if (approval) document.body.classList.add('loom-approval');
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width,initial-scale=1,viewport-fit=cover');

  const topbar = document.createElement('header');
  topbar.className = 'loom-topbar';
  topbar.innerHTML = '<span class="loom-brand">Loom</span>' +
    (received ? '' : '<span class="loom-status">Waiting for you</span>');
  const main = document.createElement('main');
  main.className = 'loom-main';
  document.querySelector('body > pre')?.remove();
  document.body.prepend(topbar);
  document.body.append(main);

  if (received) {
    title.remove();
    document.querySelector('body > .row')?.remove();
    received.remove();
    const confirmation = document.createElement('section');
    confirmation.className = 'loom-confirmation';
    confirmation.setAttribute('aria-labelledby', 'confirmation-title');
    confirmation.innerHTML = '<div class="loom-success-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg></div>' +
      '<h1 id="confirmation-title">Response sent</h1><p>Your response is back with the local task. You can close this page.</p><a class="loom-primary" href="/control/">Back to tasks</a>';
    main.append(confirmation);
    document.title = 'Response sent · Loom';
    return;
  }

  title.textContent = approval ? 'Review this request' : 'Reply to this request';
  title.classList.add('loom-visually-hidden');
  const section = form.parentElement;
  section.classList.add('loom-form');
  form.classList.add('loom-actionbar');
  main.append(title, section);
  const app = document.getElementById('app');
  const error = document.getElementById('err');
  error?.setAttribute('role', 'alert');

  function polishControls() {
    for (const control of app.querySelectorAll('.control')) {
      const input = control.querySelector('textarea, input, select');
      const label = control.querySelector('label');
      if (!input) continue;
      if (input.disabled && input.tagName === 'TEXTAREA') {
        if (label && label.textContent !== 'Request') label.textContent = 'Request';
        label?.classList.add('loom-visually-hidden');
        input.style.height = '0px';
        input.style.height = input.scrollHeight + 'px';
      } else {
        if (input.tagName === 'TEXTAREA') input.placeholder = 'Write your reply…';
        if (control.classList.contains('root_properties_decision') && input.tagName === 'SELECT') {
          for (const option of input.options) {
            const text = { '': 'Choose a decision', decline: 'Reject', accept: 'Approve this request' }[option.value];
            if (text && option.textContent !== text) option.textContent = text;
            if (text && option.label !== text) option.label = text;
          }
        }
        if (!input.dataset.loomReady) {
          input.dataset.loomReady = 'true';
          input.addEventListener('blur', () => control.classList.add('loom-touched'));
          input.addEventListener('input', () => control.classList.add('loom-touched'));
        }
        const validation = control.querySelector('.validation_error');
        if (validation && ['must NOT have fewer than 1 characters', 'is a required property'].includes(validation.textContent)) {
          validation.textContent = input.tagName === 'SELECT' ? 'Choose a decision to continue.' : 'Add a reply to continue.';
        }
      }
    }
  }
  // Keep the existing renderer, validation, hidden payload, and native POST unchanged.
  const observer = new MutationObserver(polishControls);
  observer.observe(app, { childList: true, subtree: true });
  window.addEventListener('resize', polishControls);
  polishControls();
  const submit = document.getElementById('submitBtn');
  let submitLabel = '';
  form.addEventListener('submit', event => {
    if (event.defaultPrevented || submit.disabled) return;
    submitLabel = submit.textContent;
    submit.textContent = 'Sending…';
    submit.setAttribute('aria-busy', 'true');
  });
  window.addEventListener('pageshow', () => {
    if (!submitLabel) return;
    submit.textContent = submitLabel;
    submit.removeAttribute('aria-busy');
  });
})();
