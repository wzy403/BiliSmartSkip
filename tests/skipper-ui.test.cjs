const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

// UI contract only: detection inputs and reviewed benchmark labels are untouched.
function attachSegments(segments, { mode = 'manual', paused = false, initialTime = segments[0].start } = {}) {
  const h = createHarness();
  h.setMode(mode);
  h.video.paused = paused;
  h.uiChanges = { appends: 0, removals: 0 };
  const container = h.video.parentElement;
  const appendChild = container.appendChild.bind(container);
  container.appendChild = child => {
    h.uiChanges.appends++;
    return appendChild(child);
  };
  const remove = h.button.remove.bind(h.button);
  h.button.remove = () => {
    if (h.button.parentElement) h.uiChanges.removals++;
    return remove();
  };
  h.context.__segments = segments;
  h.evaluate('currentVideo = __video; attachSkipper(__segments)');
  h.tick(initialTime);
  return h;
}

function attach({ start = 100, end = 160, paused = false } = {}) {
  return attachSegments([{ start, end, source: 'fixture', requiresConfirmation: true }], { paused });
}

function pause(h) {
  h.video.paused = true;
  h.video.dispatch('pause');
}

function play(h) {
  h.video.paused = false;
  h.video.dispatch('play');
}

function pressShortcut(h) {
  h.evaluate("SKIP_SHORTCUT = { code: 'KeyS' }; registerShortcutListener()");
  for (const { callback } of h.context.document.listeners.get('keydown') || []) {
    callback({ target: {}, code: 'KeyS', ctrlKey: false, altKey: false,
      shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
  }
}

test('suspicious prompt remains for 4999 ms and expires at exactly 5000 ms without seeking', () => {
  const h = attach();
  assert.match(h.button.textContent, /疑似广告.*5/);
  h.advanceTimers(4999);
  assert.ok(h.button.parentElement, 'the full five-second interaction window must remain available');
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.video.seeks, []);
});

test('pausing preserves the partial second already consumed by the five-second prompt', () => {
  const h = attach();
  h.advanceTimers(1250);
  pause(h);
  h.advanceTimers(10000);
  assert.ok(h.button.parentElement);
  play(h);
  h.advanceTimers(3749);
  assert.ok(h.button.parentElement);
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.video.seeks, []);
});

test('pausing after a delayed timer has consumed all five seconds immediately expires the prompt', () => {
  const h = attach();
  // Simulate a background tab whose timer callback has not run despite elapsed wall time.
  h.context.performance.now = () => 6000;
  pause(h);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.video.seeks, []);
});

test('a prompt first shown while video is paused starts its five seconds only on play', () => {
  const h = attach({ paused: true });
  h.advanceTimers(10000);
  assert.ok(h.button.parentElement);
  play(h);
  h.advanceTimers(4999);
  assert.ok(h.button.parentElement);
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
});

test('mouseleave cannot resume the countdown while the video remains paused', () => {
  const h = attach();
  h.advanceTimers(1250);
  h.button.dispatch('mouseenter');
  pause(h);
  h.button.dispatch('mouseleave');
  h.advanceTimers(10000);
  assert.ok(h.button.parentElement, 'leaving the button does not override video pause');
  play(h);
  h.advanceTimers(3749);
  assert.ok(h.button.parentElement);
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
});

test('play cannot resume the countdown while the pointer remains on the button', () => {
  const h = attach();
  h.advanceTimers(1250);
  pause(h);
  h.button.dispatch('mouseenter');
  play(h);
  h.advanceTimers(10000);
  assert.ok(h.button.parentElement, 'video play does not override pointer hover');
  h.button.dispatch('mouseleave');
  h.advanceTimers(3749);
  assert.ok(h.button.parentElement);
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
});

test('expired suspicious prompt does not reappear on later timeupdates inside the same interval', () => {
  const h = attach();
  h.advanceTimers(10000);
  for (const time of [110, 111, 112, 120, 159.999]) {
    h.tick(time);
    assert.equal(h.button.parentElement, null, `no second prompt at ${time}`);
  }
  assert.deepEqual(h.video.seeks, []);
});

test('expired suspicious prompt cannot still activate through the keyboard shortcut', () => {
  const h = attach();
  h.advanceTimers(10000);
  assert.equal(h.button.parentElement, null);
  pressShortcut(h);
  assert.deepEqual(h.video.seeks, []);
});

test('leaving a suspicious interval removes the prompt and its click action', () => {
  const h = attach();
  h.tick(160);
  assert.equal(h.button.parentElement, null);
  h.button.click();
  pressShortcut(h);
  assert.deepEqual(h.video.seeks, []);
});

test('a click cannot seek backwards to an expired target before the next timeupdate arrives', () => {
  const h = attach();
  // Seeking updates the media clock before the next timeupdate handler executes.
  h.video.position = 180;
  h.button.click();
  assert.deepEqual(h.video.seeks, []);
});

test('a shortcut cannot seek to an expired target before the next timeupdate arrives', () => {
  const h = attach();
  h.video.position = 180;
  pressShortcut(h);
  assert.deepEqual(h.video.seeks, []);
});

// A short uncertain lead-in belongs to the nearby trusted break's UI only.
// The trusted interval still starts at 141 and cannot authorize an earlier auto seek.
const relatedSegments = () => [
  { start: 136, end: 138, source: 'fixture', requiresConfirmation: true },
  { start: 141, end: 176, source: 'fixture', requiresConfirmation: false }
];

test('a nearby uncertain lead-in keeps one continuous prompt through the gap before automatic skipping', () => {
  const h = attachSegments(relatedSegments(), { mode: 'auto' });
  const button = h.button;
  h.advanceTimers(2000);
  h.tick(138);
  assert.equal(h.button, button);
  assert.ok(h.button.parentElement, 'the short lead-in ending must not remove the related prompt');
  assert.match(h.button.textContent, /疑似广告.*3/);
  h.advanceTimers(2999);
  h.tick(140.999);
  assert.ok(h.button.parentElement);
  assert.deepEqual(h.uiChanges, { appends: 1, removals: 0 });
  assert.deepEqual(h.video.seeks, [], 'UI grouping cannot move the trusted auto boundary earlier');
  h.advanceTimers(1);
  h.tick(141);
  assert.deepEqual(h.video.seeks, [176.05]);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.uiChanges, { appends: 1, removals: 1 });
});

test('clicking the related prompt in either its lead-in or its gap skips the complete break', () => {
  for (const mode of ['manual', 'auto']) {
    for (const time of [136, 138.5, 140.999]) {
      const h = attachSegments(relatedSegments(), { mode });
      h.tick(time);
      assert.ok(h.button.parentElement, `${mode} prompt remains available at ${time}`);
      h.button.click();
      assert.deepEqual(h.video.seeks, [176.05], `${mode} click at ${time} uses the related final end`);
      assert.equal(h.button.parentElement, null);
    }
  }
});

test('the related prompt keyboard shortcut uses the complete break end inside the gap', () => {
  for (const mode of ['manual', 'auto']) {
    const h = attachSegments(relatedSegments(), { mode });
    h.tick(139);
    pressShortcut(h);
    assert.deepEqual(h.video.seeks, [176.05]);
    assert.equal(h.button.parentElement, null);
  }
});

test('entering the trusted part in manual mode upgrades the existing prompt and ends the uncertain countdown', () => {
  const h = attachSegments(relatedSegments());
  // Faster playback or a forward seek may reach the trusted part before five wall-clock seconds.
  const button = h.button;
  h.advanceTimers(2000);
  h.tick(141);
  assert.equal(h.button, button);
  assert.ok(h.button.parentElement);
  assert.equal(h.button.textContent, '跳过广告');
  assert.deepEqual(h.uiChanges, { appends: 1, removals: 0 });
  assert.deepEqual(h.video.seeks, []);
  h.advanceTimers(10000);
  h.tick(150);
  assert.ok(h.button.parentElement);
  assert.equal(h.button.textContent, '跳过广告');
  assert.deepEqual(h.uiChanges, { appends: 1, removals: 0 });
  h.button.click();
  assert.deepEqual(h.video.seeks, [176.05]);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.uiChanges, { appends: 1, removals: 1 });
});

test('ignoring the related five-second prompt does not create a second prompt for its trusted part', () => {
  for (const mode of ['manual', 'auto']) {
    const h = attachSegments(relatedSegments(), { mode });
    h.advanceTimers(5000);
    assert.equal(h.button.parentElement, null);
    h.tick(141);
    assert.equal(h.button.parentElement, null, `${mode} must not re-prompt for the same break`);
    assert.deepEqual(h.uiChanges, { appends: 1, removals: 1 });
    assert.deepEqual(h.video.seeks, mode === 'auto' ? [176.05] : []);
    h.tick(150);
    assert.equal(h.button.parentElement, null);
    assert.deepEqual(h.uiChanges, { appends: 1, removals: 1 });
  }
});

test('breaks separated by more than five seconds remain independent prompts and destinations', () => {
  const segments = relatedSegments();
  segments[1].start = 144;
  const clicked = attachSegments(segments);
  clicked.button.click();
  assert.deepEqual(clicked.video.seeks, [138.05], 'the early hint must not skip the six-second body gap');

  const h = attachSegments(segments);
  h.tick(138);
  assert.equal(h.button.parentElement, null);
  h.tick(140);
  assert.equal(h.button.parentElement, null);
  h.tick(144);
  assert.ok(h.button.parentElement);
  assert.deepEqual(h.uiChanges, { appends: 2, removals: 1 });
  h.button.click();
  assert.deepEqual(h.video.seeks, [176.05]);
});

test('an uncertain segment longer than five seconds is not merged with a nearby trusted break', () => {
  const segments = relatedSegments();
  segments[0].start = 130;
  const clicked = attachSegments(segments);
  clicked.button.click();
  assert.deepEqual(clicked.video.seeks, [138.05], 'proximity cannot stretch a longer uncertain interval');

  const h = attachSegments(segments);
  h.tick(138);
  assert.equal(h.button.parentElement, null);
  h.tick(139);
  assert.equal(h.button.parentElement, null, 'the gap is outside both independent prompts');
  h.tick(141);
  assert.ok(h.button.parentElement);
  assert.deepEqual(h.uiChanges, { appends: 2, removals: 1 });
  h.button.click();
  assert.deepEqual(h.video.seeks, [176.05]);
});

test('seeking directly into a trusted part retains its ordinary manual and automatic behavior', () => {
  const manual = attachSegments(relatedSegments(), { initialTime: 150 });
  assert.ok(manual.button.parentElement);
  assert.equal(manual.button.textContent, '跳过广告');
  assert.deepEqual(manual.video.seeks, []);
  manual.advanceTimers(10000);
  assert.ok(manual.button.parentElement, 'an unseen earlier hint cannot impose a countdown on the trusted part');
  manual.button.click();
  assert.deepEqual(manual.video.seeks, [176.05]);

  const automatic = attachSegments(relatedSegments(), { mode: 'auto', initialTime: 150 });
  assert.deepEqual(automatic.video.seeks, [176.05]);
  assert.equal(automatic.button.parentElement, null);
  assert.equal(automatic.uiChanges.appends, 0);
});

test('an ad that runs to the end of the video stops just short of it and never restarts playback', () => {
  // Resuming an ended <video> restarts it from 0:00; reaching the end by
  // itself lets the player finish normally (next video, replay panel).
  for (const mode of ['auto', 'manual']) {
    const h = createHarness();
    h.video.duration = 600;
    h.setMode(mode);
    h.context.__segments = [{ start: 560, end: 600, source: 'fixture', requiresConfirmation: false }];
    h.evaluate('currentVideo = __video; attachSkipper(__segments)');
    h.tick(565);
    if (mode === 'manual') h.button.click();
    assert.equal(h.video.seeks.length, 1, mode);
    assert.ok(Math.abs(h.video.seeks[0] - 599.7) < 1e-9, mode);
    let resumed = 0;
    h.video.play = async () => { resumed++; };
    h.video.paused = true; h.video.ended = true;
    h.video.dispatch('seeked');
    h.advanceTimers(2000);
    assert.equal(resumed, 0, mode);
    h.tick(599.8);
    assert.equal(h.video.seeks.length, 1, `${mode}: no second seek while finishing`);
    // The skip landed inside the ad's last 0.3 s: that is not a return to it.
    assert.equal(h.button.parentElement, null, `${mode}: no button for the final moments`);
    h.tick(570);
    assert.ok(h.button.parentElement, `${mode}: dragging back from the end offers the button`);
    assert.equal(h.button.textContent, '跳过广告');
    assert.equal(h.video.seeks.length, 1, `${mode}: never skipped unprompted a second time`);
  }
  // Ordinary mid-video ads are unaffected.
  const h = createHarness();
  h.video.duration = 600;
  h.setMode('auto');
  h.context.__segments = [{ start: 100, end: 160, source: 'fixture', requiresConfirmation: false }];
  h.evaluate('currentVideo = __video; attachSkipper(__segments)');
  h.tick(100);
  assert.deepEqual(h.video.seeks, [160.05]);
});

// Coming back to an ad that was already skipped. A detection can be wrong, so
// the ad has to stay watchable: nothing is skipped unprompted twice, and every
// return offers the button again (as releases up to 2.1.0 did).
const confirmedAd = () => [{ start: 100, end: 160, source: 'fixture', requiresConfirmation: false }];

// A finished seek as a browser reports it: the new position, then `seeked`.
function land(h) {
  h.tick(h.video.seeks.at(-1));
  h.video.dispatch('seeked');
}

test('automatic mode skips an ad once, then offers the button on every return', () => {
  const h = attachSegments(confirmedAd(), { mode: 'auto' });
  assert.deepEqual(h.video.seeks, [160.05]);
  land(h);
  assert.equal(h.button.parentElement, null);
  for (const time of [130, 100, 159.9]) {
    h.tick(time);
    assert.ok(h.button.parentElement, `returning to ${time} offers the button`);
    assert.equal(h.button.textContent, '跳过广告');
    h.advanceTimers(10000);
    h.tick(time + 0.05);
    assert.ok(h.button.parentElement, 'a confirmed ad has no countdown: the button stays for the whole visit');
    assert.deepEqual(h.video.seeks, [160.05], 'never a second unprompted seek');
    h.tick(200);
    assert.equal(h.button.parentElement, null);
  }
  h.tick(130);
  h.button.click();
  assert.deepEqual(h.video.seeks, [160.05, 160.05], 'the button skips it again');
  assert.equal(h.button.parentElement, null);
});

test('manual mode offers the button again each time the viewer returns to an ad they skipped', () => {
  const h = attachSegments(confirmedAd());
  for (let visit = 1; visit <= 3; visit++) {
    h.tick(110);
    assert.ok(h.button.parentElement, `visit ${visit}`);
    assert.equal(h.button.textContent, '跳过广告');
    h.button.click();
    assert.equal(h.video.seeks.length, visit);
    assert.equal(h.button.parentElement, null);
    land(h);
    assert.equal(h.button.parentElement, null);
  }
  assert.deepEqual(h.uiChanges, { appends: 3, removals: 3 });
});

test('no button appears while a skip is still seeking', () => {
  for (const mode of ['auto', 'manual']) {
    const h = attachSegments(confirmedAd(), { mode });
    if (mode === 'manual') h.button.click();
    const shown = h.uiChanges.appends;
    // Until the seek lands, a player can keep reporting positions inside the ad.
    for (const time of [100.2, 100.4, 100.9]) {
      h.tick(time);
      assert.equal(h.button.parentElement, null, `${mode} at ${time}`);
    }
    assert.equal(h.uiChanges.appends, shown, `${mode}: nothing flashed`);
    assert.deepEqual(h.video.seeks, [160.05], `${mode}: one seek`);
    land(h);
    assert.equal(h.button.parentElement, null, mode);
  }
});

test('rewinding the moment a skip lands still offers the button', () => {
  // The seek finished, and the viewer is back inside the ad before any
  // timeupdate was delivered from outside it.
  for (const mode of ['auto', 'manual']) {
    const h = attachSegments(confirmedAd(), { mode });
    if (mode === 'manual') h.button.click();
    h.video.dispatch('seeked');
    h.tick(130);
    assert.ok(h.button.parentElement, mode);
    assert.equal(h.button.textContent, '跳过广告');
    assert.deepEqual(h.video.seeks, [160.05], mode);
  }
});

test('a skip the player never carried out leaves the viewer a button', () => {
  for (const mode of ['auto', 'manual']) {
    const h = attachSegments(confirmedAd(), { mode });
    if (mode === 'manual') h.button.click();
    h.tick(100.5);
    assert.equal(h.button.parentElement, null, `${mode}: still waiting for the seek`);
    h.advanceTimers(1000); // `seeked` never fired
    h.tick(101.5);
    assert.ok(h.button.parentElement, mode);
    assert.equal(h.button.textContent, '跳过广告');
    assert.deepEqual(h.video.seeks, [160.05], `${mode}: not retried unprompted`);
    h.button.click();
    assert.deepEqual(h.video.seeks, [160.05, 160.05], mode);
  }
});

test('the shortcut works whenever the button is on screen, also after coming back', () => {
  for (const mode of ['auto', 'manual']) {
    const h = attachSegments(confirmedAd(), { mode });
    pressShortcut(h); // manual: skips. automatic: already skipped, nothing on screen
    assert.deepEqual(h.video.seeks, [160.05], mode);
    pressShortcut(h);
    assert.deepEqual(h.video.seeks, [160.05], `${mode}: no button, nothing to do`);
    land(h);
    pressShortcut(h);
    assert.deepEqual(h.video.seeks, [160.05], `${mode}: nothing to do outside the ad`);
    h.tick(120);
    pressShortcut(h);
    assert.deepEqual(h.video.seeks, [160.05, 160.05], `${mode}: skips again after returning`);
    assert.equal(h.button.parentElement, null);
  }
});

test('a suspected ad the viewer skipped is offered again with a fresh countdown', () => {
  const h = attach();
  h.advanceTimers(2000);
  h.button.click();
  assert.deepEqual(h.video.seeks, [160.05]);
  land(h);
  h.tick(120);
  assert.match(h.button.textContent, /疑似广告.*5/);
  h.advanceTimers(4999);
  assert.ok(h.button.parentElement);
  h.advanceTimers(1);
  assert.equal(h.button.parentElement, null);
  h.tick(125);
  assert.equal(h.button.parentElement, null, 'still one prompt per visit');
  assert.deepEqual(h.video.seeks, [160.05]);
});

test('coming back to a break with an uncertain lead-in offers the whole break again', () => {
  const h = attachSegments(relatedSegments(), { mode: 'auto', initialTime: 141 });
  assert.deepEqual(h.video.seeks, [176.05]);
  land(h);
  h.tick(150); // back in the confirmed part
  assert.ok(h.button.parentElement);
  assert.equal(h.button.textContent, '跳过广告');
  h.tick(180);
  h.tick(136.5); // back in the lead-in, which is still only suspected
  assert.match(h.button.textContent, /疑似广告.*5/);
  h.tick(141); // playing on into the confirmed part
  assert.equal(h.button.textContent, '跳过广告');
  assert.deepEqual(h.video.seeks, [176.05], 'the confirmed part is not skipped unprompted a second time');
  h.button.click();
  assert.deepEqual(h.video.seeks, [176.05, 176.05]);
});

test('a skip that lands inside the next ad starts that ad normally', () => {
  const adjacent = () => [
    { start: 100, end: 160, source: 'fixture', requiresConfirmation: false },
    { start: 160, end: 200, source: 'fixture', requiresConfirmation: false }
  ];
  const manual = attachSegments(adjacent());
  manual.button.click();
  land(manual);
  assert.ok(manual.button.parentElement, 'the next ad gets its own button');
  manual.button.click();
  assert.deepEqual(manual.video.seeks, [160.05, 200.05]);

  const automatic = attachSegments(adjacent(), { mode: 'auto' });
  land(automatic);
  assert.deepEqual(automatic.video.seeks, [160.05, 200.05]);
  land(automatic);
  assert.equal(automatic.button.parentElement, null);
});

test('a replacement player inside an ad that was already skipped offers the button', () => {
  const h = attachSegments(confirmedAd(), { mode: 'auto' });
  land(h);
  h.evaluate('attachSkipper(__segments)');
  h.tick(130);
  assert.ok(h.button.parentElement);
  assert.equal(h.button.textContent, '跳过广告');
  assert.deepEqual(h.video.seeks, [160.05]);
});
