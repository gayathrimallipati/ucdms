/**
 * Helpers that match the live custom components in
 * dms.jlr.local/pages/lib/select.js
 * dms.jlr.local/pages/lib/dateTime-picker.js
 * dms.jlr.local/pages/views/pm/vaahan.js
 * dms.jlr.local/pages/views/pm/verify.js
 * dms.jlr.local/pages/views/pm/add.js
 */
const { expect } = require('@playwright/test');

async function dismissAppModals(page) {
  const notNow = page.getByRole('button', { name: /Not Now/i });
  try {
    await notNow.waitFor({ state: 'visible', timeout: 4000 });
    await notNow.click();
    await expect(notNow).toBeHidden({ timeout: 5000 }).catch(() => {});
  } catch {
    // no notification modal
  }
}

function selectWrapper(page, fieldId) {
  return page.locator(`#${fieldId}.selectsearch-wrapper`);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

function isPlaceholderLabel(text) {
  const t = String(text || '').trim();
  return !t
    || /^select\s/i.test(t)
    || /^(reason|area|city|state|make \(interested\)|model \(interested\)|variant \(interested\))$/i.test(t);
}

function matchesExclude(text, exclude = []) {
  return exclude.some((rule) => {
    if (rule instanceof RegExp) return rule.test(text);
    return String(text).toLowerCase().includes(String(rule).toLowerCase());
  });
}

function optionItems(scope) {
  return scope.locator('div.px-3.py-2.cursor-pointer, .selectsearch-mobile-modal__option');
}

async function isInputMode(wrapper) {
  return (await wrapper.locator('input.border-0.w-100').count()) > 0;
}

async function isDisabledSelect(wrapper) {
  return wrapper.evaluate((el) => el.classList.contains('opacity-50'));
}

async function currentSelectLabel(page, fieldId) {
  const wrapper = selectWrapper(page, fieldId);
  if (!(await isVisible(wrapper))) return '';
  if (await isInputMode(wrapper)) {
    return wrapper.locator('input.border-0.w-100').inputValue().catch(() => '');
  }
  return (await wrapper.locator('.selectsearch-trigger').innerText()).trim();
}

async function isSelectUnset(page, fieldId) {
  const wrapper = selectWrapper(page, fieldId);
  if (!(await isVisible(wrapper))) return true;
  if (await wrapper.locator('.selectsearch-trigger .text-muted').isVisible().catch(() => false)) {
    return true;
  }
  const current = await currentSelectLabel(page, fieldId);
  return isPlaceholderLabel(current);
}

async function closeOpenSelectSearch(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.selectsearch-wrapper').forEach((el) => {
      el.__vueSelectSearch?.closeDropdown?.();
    });
  }).catch(() => {});
  const mobileClose = page.locator('.selectsearch-mobile-modal .btn-close');
  if (await isVisible(mobileClose)) await mobileClose.click().catch(() => {});
}

function isRealOptionLabel(text) {
  const t = String(text || '').trim();
  return Boolean(t) && !isPlaceholderLabel(t) && !/^loading/i.test(t) && t !== 'No results found';
}

async function countRealSelectOptions(wrapper) {
  return wrapper.evaluate((el) => {
    const inst = el.__vueSelectSearch;
    if (!inst) return -1;
    const items = inst.allItems || [];
    return items.filter((item) => {
      const value = item.value ?? item.id ?? item[inst.optionValue];
      const label = String(item.label ?? item.name ?? item[inst.optionLabel] ?? '').trim();
      if (value === '' || value == null) return false;
      if (/^select\s/i.test(label) || /^loading/i.test(label)) return false;
      if (item.is_disabled === 'y' || item.disabled) return false;
      return true;
    }).length;
  });
}

async function countRealDomOptions(opened) {
  const items = optionItems(opened.list);
  const n = await items.count();
  let real = 0;
  for (let i = 0; i < n; i++) {
    const text = (await items.nth(i).innerText()).trim();
    const disabled = await items.nth(i).evaluate((el) => el.classList.contains('opacity-50'));
    if (isRealOptionLabel(text) && !disabled) real += 1;
  }
  return real;
}

/**
 * Open the custom SelectSearch, then wait until real options are in the DOM.
 * Source/make/branch options arrive from getCollections; dependents fill after
 * the parent change. Do not wait only on the Vue instance — options often
 * appear only after the dropdown is open.
 */
async function waitForRealOptions(page, fieldId, timeout = 25000) {
  const wrapper = selectWrapper(page, fieldId);
  await expect(wrapper).toBeVisible({ timeout });
  if (!(await isSelectUnset(page, fieldId))) return;
  try {
    await expect.poll(async () => countRealSelectOptions(wrapper), {
      timeout: Math.min(timeout, 8000),
    }).toBeGreaterThan(0);
    return;
  } catch {
    // Options often land on the instance only after the menu is open.
  }
  const opened = await openSelectSearch(page, fieldId);
  try {
    await expect.poll(async () => countRealDomOptions(opened), {
      timeout,
      message: `SelectSearch #${fieldId} still has no options (waiting for master-data / parent field)`,
    }).toBeGreaterThan(0);
  } finally {
    await closeOpenSelectSearch(page);
  }
}

async function openSelectSearch(page, fieldId) {
  await dismissAppModals(page);
  await closeOpenSelectSearch(page);
  const wrapper = selectWrapper(page, fieldId);
  await expect(wrapper).toBeVisible({ timeout: 20000 });
  if (await isDisabledSelect(wrapper)) {
    throw new Error(`SelectSearch #${fieldId} is disabled`);
  }
  await wrapper.scrollIntoViewIfNeeded();
  await expect.poll(async () => wrapper.evaluate((el) => !!el.__vueSelectSearch), {
    timeout: 15000,
    message: `SelectSearch #${fieldId} Vue instance not ready`,
  }).toBeTruthy();

  if (await isInputMode(wrapper)) {
    const input = wrapper.locator('input.border-0.w-100');
    await input.click();
    return { wrapper, mode: 'input', list: wrapper.locator('.selectsearch-dropdown') };
  }

  // Force-open via the component so the 320ms click debounce in select.js
  // cannot swallow a second open and leave the list hidden.
  await wrapper.evaluate((el) => {
    el.__vueSelectSearch.toggleDropdown(true);
  });

  const mobile = page.locator('.selectsearch-mobile-modal');
  try {
    await mobile.waitFor({ state: 'visible', timeout: 800 });
    if (await isVisible(mobile)) {
      return { wrapper, mode: 'mobile', list: mobile };
    }
  } catch {
    // desktop dropdown
  }
  const dropdown = wrapper.locator('.selectsearch-dropdown');
  await expect(dropdown).toBeVisible({ timeout: 10000 });
  return { wrapper, mode: 'select', list: dropdown };
}

async function typeSelectSearchFilter(opened, text) {
  if (!text) return;
  const search = opened.list.locator('input[placeholder="Search..."], .selectsearch-mobile-search-input').first();
  if (!(await search.count())) return;
  if (opened.mode === 'mobile') {
    await search.click();
  }
  await search.fill(String(text));
}

function randomInt(max) {
  if (max <= 1) return 0;
  return Math.floor(Math.random() * max);
}

async function pickSelectItem(opened, { label, index, exclude = [] } = {}) {
  const items = optionItems(opened.list);
  await expect.poll(async () => items.count(), { timeout: 15000 }).toBeGreaterThan(0);

  let item = null;
  if (label) {
    const exact = items.filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    item = (await exact.count()) ? exact.first() : items.filter({ hasText: label }).first();
  } else {
    const count = await items.count();
    const real = [];
    for (let i = 0; i < count; i++) {
      const text = (await items.nth(i).innerText()).trim();
      const disabled = await items.nth(i).evaluate((el) => el.classList.contains('opacity-50'));
      if (text && !isPlaceholderLabel(text) && !disabled && !matchesExclude(text, exclude)) {
        real.push(i);
      }
    }
    const pickAt = typeof index === 'number'
      ? Math.min(Math.max(index, 0), Math.max(real.length - 1, 0))
      : randomInt(real.length);
    const domIndex = real[pickAt] ?? real[0] ?? 0;
    item = items.nth(domIndex);
  }

  await expect(item).toBeVisible({ timeout: 10000 });
  const text = (await item.innerText()).trim();
  await item.click();
  return text;
}

async function selectSearchOption(page, fieldId, opts = {}) {
  const opened = await openSelectSearch(page, fieldId);
  await expect.poll(async () => countRealDomOptions(opened), {
    timeout: opts.optionsTimeout || 25000,
    message: `SelectSearch #${fieldId} opened but has no real options yet`,
  }).toBeGreaterThan(0);
  if (opts.search) {
    await typeSelectSearchFilter(opened, opts.search);
    const found = await countRealDomOptions(opened);
    if (!found) {
      await typeSelectSearchFilter(opened, '');
    }
  }
  const text = await pickSelectItem(opened, opts);
  if (opened.mode === 'input') {
    await expect(opened.list).toBeHidden({ timeout: 8000 }).catch(() => {});
  } else {
    await expect(opened.wrapper.locator('.selectsearch-dropdown')).toBeHidden({ timeout: 8000 }).catch(() => {});
    await expect(opened.wrapper.locator('.selectsearch-trigger')).not.toContainText(/^Select /i, { timeout: 8000 });
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  if (opts.waitFor) {
    const next = Array.isArray(opts.waitFor) ? opts.waitFor : [opts.waitFor];
    for (const nextId of next) {
      const nextWrap = selectWrapper(page, nextId);
      try {
        await expect(nextWrap).toBeVisible({ timeout: 15000 });
        await waitForRealOptions(page, nextId, 25000);
      } catch {
        console.log(`  #${nextId} still has no options after #${fieldId}=${text}`);
      }
    }
  }
  return text;
}

async function selectIfVisible(page, fieldId, opts = {}) {
  const wrapper = selectWrapper(page, fieldId);
  if (!(await isVisible(wrapper))) return null;
  if (await isDisabledSelect(wrapper)) return currentSelectLabel(page, fieldId);
  if (opts.onlyIfEmpty) {
    if (!(await isSelectUnset(page, fieldId))) {
      return currentSelectLabel(page, fieldId);
    }
  }
  try {
    return await selectSearchOption(page, fieldId, opts);
  } catch (err) {
    if (opts.noFallback) {
      console.log(`  SelectSearch #${fieldId}: ${err.message}`);
      return null;
    }
    if (opts.label || opts.search || (opts.exclude && opts.exclude.length)) {
      try {
        return await selectSearchOption(page, fieldId, { exclude: opts.exclude });
      } catch {
        return null;
      }
    }
    console.log(`  skipped SelectSearch #${fieldId}: ${err.message}`);
    return null;
  }
}

/**
 * Exterior/interior color lists are not in the first getCollections payload as
 * dropdown options. Make's inputChange runs dynamic_models then dynamic_colors.
 * Automation often opens #color while that second call is still clearing/fetching,
 * sees only "Select Exterior Color", and skips. A normal click waits.
 */
async function retriggerDynamicColors(page) {
  return page.evaluate(async () => {
    const wrap = document.querySelector('#make.selectsearch-wrapper');
    const vue = wrap && wrap.__vueSelectSearch;
    const makeId = vue && (vue.modelValue || (vue.selectedItem && vue.selectedItem.id));
    if (!makeId) return 'no-make';

    let parent = vue && (vue.$parent || vue.$?.parent?.proxy);
    for (let i = 0; i < 8 && parent && !parent.store; i += 1) {
      parent = parent.$parent || parent.$?.parent?.proxy;
    }
    const store = parent && parent.store;
    if (!store || typeof store.dynamic_colors !== 'function') return 'no-store';
    await store.dynamic_colors(String(makeId), '', 'detailAddConfig');
    return 'retried';
  });
}

async function waitForColorList(page, fieldId = 'color', timeout = 30000) {
  const wrapper = selectWrapper(page, fieldId);
  await expect(wrapper).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  try {
    await waitForRealOptions(page, fieldId, timeout);
    return true;
  } catch {
    const recovered = await retriggerDynamicColors(page);
    console.log(`  #${fieldId}: empty after make — ${recovered}`);
    if (recovered !== 'retried') return false;
    await waitForRealOptions(page, fieldId, timeout);
    return true;
  }
}

async function selectColorAfterMake(page, fieldId = 'color', opts = {}) {
  const wrapper = selectWrapper(page, fieldId);
  if (fieldId === 'interior_color' && !(await isVisible(wrapper))) {
    console.log('  interior_color: hidden (only shown for JLR makes)');
    return null;
  }
  try {
    await expect(wrapper).toBeVisible({ timeout: 15000 });
  } catch {
    console.log(`  ${fieldId}: hidden (needs Registration Type, then Make)`);
    return null;
  }
  if (opts.onlyIfEmpty && !(await isSelectUnset(page, fieldId))) {
    return currentSelectLabel(page, fieldId);
  }
  const ready = await waitForColorList(page, fieldId).catch((err) => {
    console.log(`  ${fieldId}: ${err.message}`);
    return false;
  });
  if (!ready) return null;
  return selectSearchOption(page, fieldId, { optionsTimeout: 20000 });
}

/**
 * pin_code_search is SelectSearch with inputType="input".
 * Typing 3–6 digits calls store.dynamic_location_search → getareasbypincode.
 * Picking an option emits change → store.dynamic_location → getstatecitybyarea,
 * which writes the read-only Area / City / State fields. Those cannot be typed.
 */
const PIN_CODE_POOL = ['400001', '110001', '560001', '600001', '700001', '411001', '302001', '500001'];

function pinCodeDependents(fieldId) {
  if (fieldId === 'rc_pin_code') {
    return { area: 'rc_area_name', city: 'rc_city_name', state: 'rc_state_name' };
  }
  if (fieldId === 'customer_pin_code') {
    return { area: 'customer_area_name', city: 'customer_city_name', state: 'customer_state_name' };
  }
  if (fieldId === 'billing_pin_code') {
    return { area: 'billing_area_name', city: 'billing_city_name', state: 'billing_state_name' };
  }
  return { area: 'area_name', city: 'city_name', state: 'state_name' };
}

function isLocationEmpty(value) {
  const t = String(value || '').trim();
  return !t || /^(area|city|state)$/i.test(t);
}

function isMasterDataPost(response) {
  return response.request().method() === 'POST' && /master-data/i.test(response.url());
}

async function masterDataMeta(response) {
  const req = response.request();
  let raw = '';
  try {
    raw = req.postData() || '';
  } catch {
    raw = '';
  }
  let json = null;
  try {
    json = req.postDataJSON();
  } catch {
    json = null;
  }
  const body = await response.json().catch(() => null);
  const msg = String(body?.msg || '');
  const action = String(json?.action || '').toLowerCase()
    || ((/getareasbypincode/i.test(raw) && 'getareasbypincode')
      || (/getstatecitybyarea/i.test(raw) && 'getstatecitybyarea')
      || (/areas list|empty areas list/i.test(msg) && 'getareasbypincode')
      || (/from area/i.test(msg) && 'getstatecitybyarea')
      || '');
  const pinFromRaw = (String(raw).match(/pin_code["'=\s:]+(\d{3,6})/i) || [])[1] || '';
  const areaFromRaw = (String(raw).match(/["']?area["'=\s:]+(\d+)/i) || [])[1] || '';
  return {
    action,
    pin: String(json?.pin_code || pinFromRaw || ''),
    area: String(json?.area || areaFromRaw || ''),
    body,
    msg,
  };
}

function isAreasByPincodeMeta(meta) {
  return meta.action === 'getareasbypincode' || /areas list|empty areas list/i.test(meta.msg);
}

function isStateCityByAreaMeta(meta) {
  return meta.action === 'getstatecitybyarea' || /from area/i.test(meta.msg);
}

async function waitForFinalAreasByPincode(page, pin, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const quietMs = last ? 1500 : Math.min(8000, remaining);
    const res = await page.waitForResponse(async (response) => {
      if (!isMasterDataPost(response)) return false;
      const meta = await masterDataMeta(response);
      if (!isAreasByPincodeMeta(meta)) return false;
      if (pin && meta.pin && meta.pin !== String(pin)) return false;
      return true;
    }, { timeout: quietMs }).catch(() => null);
    if (res) {
      last = await masterDataMeta(res);
      continue;
    }
    if (last) return last;
  }
  return last;
}

async function waitForStateCityByArea(page, timeout = 20000) {
  const res = await page.waitForResponse(async (response) => {
    if (!isMasterDataPost(response)) return false;
    return isStateCityByAreaMeta(await masterDataMeta(response));
  }, { timeout }).catch(() => null);
  return res ? masterDataMeta(res) : null;
}

async function storeAreaOptions(page, fieldId) {
  return page.evaluate((id) => {
    const app = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const store = pinia?._s?.get('pm');
    const list = store?.masterLists?.[id];
    if (!Array.isArray(list)) return [];
    return list
      .map((o) => ({ value: String(o?.value ?? ''), label: String(o?.label ?? '') }))
      .filter((o) => o.value && o.value !== '0' && /^\d+$/.test(o.value));
  }, fieldId);
}

async function applyPinAndAreaViaStore(page, fieldId, pin, areaId) {
  return page.evaluate(async ({ fieldId: id, pin: zip, areaId: area }) => {
    const app = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const store = pinia?._s?.get('pm');
    if (!store) return { ok: false, error: 'pm store missing' };
    const configKey = 'detailAddConfig';
    const fields = typeof store.getAllFields === 'function'
      ? store.getAllFields(store[configKey] || {})
      : [];
    const field = (fields || []).find((f) => f.fieldKey === id);
    if (!field) return { ok: false, error: `${id} field missing` };
    if (zip && typeof store.dynamic_location_search === 'function') {
      await store.dynamic_location_search(String(zip), field, configKey);
    }
    const list = Array.isArray(store.masterLists?.[id]) ? store.masterLists[id] : [];
    const picked = area
      || String(list.find((o) => o && o.value && String(o.value) !== '0')?.value || '');
    if (!picked || !/^\d+$/.test(String(picked))) {
      return { ok: false, error: 'no numeric area id', count: list.length };
    }
    if (typeof store.dynamic_location === 'function') {
      await store.dynamic_location(String(picked), field, configKey);
    }
    return { ok: true, area: String(picked) };
  }, { fieldId, pin, areaId });
}

async function locationFieldsFilled(page, fieldId) {
  const deps = pinCodeDependents(fieldId);
  const values = {};
  for (const [key, id] of Object.entries(deps)) {
    const el = page.locator(`#${id}`).first();
    if (!(await isVisible(el))) {
      values[key] = '';
      continue;
    }
    values[key] = (await el.inputValue().catch(() => '')).trim();
  }
  const visibleDeps = [];
  for (const id of Object.values(deps)) {
    if (await isVisible(page.locator(`#${id}`).first())) visibleDeps.push(id);
  }
  if (!visibleDeps.length) return { ok: true, values };
  const ok = !isLocationEmpty(values.area)
    && !isLocationEmpty(values.city)
    && !isLocationEmpty(values.state);
  return { ok, values };
}

async function fillOnePinCodeSearch(page, fieldId, chosenPin) {
  const wrapper = selectWrapper(page, fieldId);
  await wrapper.scrollIntoViewIfNeeded();
  const input = wrapper.locator('input.border-0.w-100');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');

  const prefix = chosenPin.slice(0, -1);
  const lastDigit = chosenPin.slice(-1);
  if (prefix) await input.pressSequentially(prefix, { delay: 50 });
  const areasWait = waitForFinalAreasByPincode(page, chosenPin);
  await input.pressSequentially(lastDigit, { delay: 50 });
  await expect.poll(async () => input.inputValue(), { timeout: 5000 }).toBe(chosenPin);
  const areasMeta = await areasWait;

  await wrapper.evaluate((el) => el.__vueSelectSearch?.toggleDropdown(true));
  const dropdown = wrapper.locator('.selectsearch-dropdown');
  await expect(dropdown).toBeVisible({ timeout: 15000 });
  const items = optionItems(dropdown);

  await expect.poll(async () => {
    const fromStore = await storeAreaOptions(page, fieldId);
    if (fromStore.length) return fromStore.length;
    const texts = await items.allInnerTexts().catch(() => []);
    return texts.filter((t) => t.trim() && !/^select\s/i.test(t.trim())).length;
  }, { timeout: 20000, message: `getareasbypincode returned no areas for ${chosenPin}` }).toBeGreaterThan(0);

  let lastCount = -1;
  for (let i = 0; i < 10; i++) {
    const n = await items.count();
    if (n > 0 && n === lastCount) break;
    lastCount = n;
    await page.waitForTimeout(200);
  }

  const apiList = Array.isArray(areasMeta?.body?.data?.list) ? areasMeta.body.data.list : [];
  const storeList = await storeAreaOptions(page, fieldId);
  const options = (storeList.length ? storeList : apiList)
    .map((o) => ({ value: String(o?.value ?? ''), label: String(o?.label ?? '') }))
    .filter((o) => o.value && o.value !== '0' && /^\d+$/.test(o.value));
  if (!options.length) {
    throw new Error(`getareasbypincode returned no numeric areas for ${chosenPin}`);
  }
  const choice = options[randomInt(options.length)];

  const cityWait = waitForStateCityByArea(page);
  const selected = await wrapper.evaluate((el, payload) => {
    const cmp = el.__vueSelectSearch;
    if (!cmp?.selectItem) return false;
    cmp.selectItem({ value: payload.value, label: payload.label });
    return true;
  }, choice);
  if (!selected) {
    const byLabel = items.filter({ hasText: choice.label }).first();
    if (await byLabel.count()) await byLabel.click();
    else await items.first().click();
  }
  await expect(dropdown).toBeHidden({ timeout: 8000 }).catch(() => {});
  await cityWait;

  let filled = await locationFieldsFilled(page, fieldId);
  if (!filled.ok) {
    const fallback = await applyPinAndAreaViaStore(page, fieldId, chosenPin, choice.value);
    if (!fallback.ok) {
      console.log(`  ${fieldId}: store getstatecitybyarea fallback failed (${fallback.error || 'unknown'})`);
    }
    await expect.poll(async () => (await locationFieldsFilled(page, fieldId)).ok, {
      timeout: 15000,
      message: `getstatecitybyarea did not fill Area/City/State after ${chosenPin} → ${choice.label}`,
    }).toBeTruthy();
    filled = await locationFieldsFilled(page, fieldId);
  }

  console.log(`  ${fieldId}: ${chosenPin} → ${choice.label} (${filled.values.area} / ${filled.values.city} / ${filled.values.state})`);
  return true;
}

async function fillPinCodeSearch(page, fieldId, pin) {
  const wrapper = selectWrapper(page, fieldId);
  if (!(await isVisible(wrapper))) return false;
  if (await isDisabledSelect(wrapper)) return false;

  const already = await locationFieldsFilled(page, fieldId);
  if (already.ok && already.values.city) return true;

  const pins = pin
    ? [String(pin)]
    : PIN_CODE_POOL.slice().sort(() => Math.random() - 0.5);
  let lastError = null;
  for (const chosenPin of pins) {
    try {
      await fillOnePinCodeSearch(page, fieldId, chosenPin);
      return true;
    } catch (err) {
      lastError = err;
      console.log(`  ${fieldId} ${chosenPin} did not fill Area/City/State — trying another pincode`);
    }
  }
  throw lastError || new Error(`Could not fill Area/City/State from ${fieldId}`);
}

async function pickDateInWrapper(wrap) {
  await wrap.scrollIntoViewIfNeeded();
  const current = await wrap.locator('input.form-control').inputValue().catch(() => '');
  if (current && current.trim() && !/^DD-MM-YYYY/i.test(current)) return current;
  await wrap.locator('.input-group').click();
  const days = wrap.locator('.calendar-part div').filter({ hasText: /^\d{1,2}$/ });
  await expect.poll(async () => days.count(), { timeout: 8000 }).toBeGreaterThan(0);
  const n = await days.count();
  let clicked = false;
  for (let i = n - 1; i >= 0; i--) {
    const day = days.nth(i);
    const allowed = await day.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return /cursor:\s*pointer/i.test(style) && !/pointer-events:\s*none/i.test(style);
    }).catch(() => false);
    if (!allowed) continue;
    await day.click();
    clicked = true;
    break;
  }
  if (!clicked) await days.last().click();
  const done = wrap.getByRole('button', { name: /^Done$/i });
  if (await isVisible(done)) await done.click();
  return wrap.locator('input.form-control').inputValue().catch(() => current);
}

async function pickDateIfVisible(page, fieldId) {
  const wrap = page.locator(`label[for="${fieldId}"]`)
    .locator('xpath=following::div[contains(@class,"dtp-wrapper")][1]')
    .or(page.locator(`label[for="${fieldId}"]`).locator('xpath=ancestor::div[contains(@class,"col-")][1]').locator('.dtp-wrapper'))
    .first();
  if (!(await isVisible(wrap))) return false;
  await pickDateInWrapper(wrap);
  return true;
}

/**
 * Vaahan addon on #reg_num — button title="Fetch Vahan Data".
 * If the preview modal opens, click Apply so mapped custom fields fill.
 */
async function tryVaahanFetch(page) {
  const btn = page.locator('button[title="Fetch Vahan Data"], button[title="Fetch from Vaahan"]').first();
  if (!(await isVisible(btn))) {
    console.log('  custom Vaahan addon: not visible');
    return false;
  }
  console.log('  custom Vaahan addon: clicking Fetch');
  await btn.click();
  const preview = page.getByText('Vaahan Details Preview');
  try {
    await preview.waitFor({ state: 'visible', timeout: 12000 });
    await page.getByRole('button', { name: /^Apply$/i }).click();
    await expect(preview).toBeHidden({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log('  custom Vaahan addon: applied');
    return true;
  } catch {
    console.log('  custom Vaahan addon: no preview (reg not in Vaahan) — filling fields manually');
    return false;
  }
}

async function noteVerifyAddons(page) {
  const buttons = page.locator('button[title^="Verify "]');
  const count = await buttons.count();
  console.log(`  custom Verify addon: ${count > 0 ? `${count} visible (OTP modal not completed)` : 'hidden for this user'}`);
}

/**
 * After structured fills, walk every remaining visible custom component
 * from add.js (SelectSearch, pin_code_search, DateTimePicker) and fill empties.
 */
async function fillRemainingCustomFields(page) {
  const wrappers = page.locator('form .selectsearch-wrapper');
  const n = await wrappers.count();
  for (let i = 0; i < n; i++) {
    const wrapper = wrappers.nth(i);
    if (!(await isVisible(wrapper))) continue;
    if (await isDisabledSelect(wrapper)) continue;
    const id = await wrapper.getAttribute('id');
    if (!id) continue;
    if (await isInputMode(wrapper)) {
      const filled = await locationFieldsFilled(page, id);
      if (!filled.ok) {
        await fillPinCodeSearch(page, id);
      }
      continue;
    }
    if (await isSelectUnset(page, id)) {
      const picked = await selectIfVisible(page, id);
      if (picked) console.log(`  leftover SelectSearch #${id}: ${picked}`);
    }
  }

  const pickers = page.locator('form .dtp-wrapper');
  const p = await pickers.count();
  for (let i = 0; i < p; i++) {
    const wrap = pickers.nth(i);
    if (!(await isVisible(wrap))) continue;
    const val = (await wrap.locator('input.form-control').inputValue().catch(() => '')).trim();
    if (!val) {
      await pickDateInWrapper(wrap).catch((err) => {
        console.log(`  leftover DateTimePicker: ${err.message}`);
      });
    }
  }
}

async function fillById(page, fieldId, value) {
  const input = page.locator(`#${fieldId}`);
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(String(value));
}

async function fillIfVisible(page, fieldId, value, { onlyIfEmpty = false } = {}) {
  const el = page.locator(`#${fieldId}`).first();
  if (!(await isVisible(el))) return false;
  if (await el.evaluate((node) => node.classList.contains('selectsearch-wrapper'))) {
    return false;
  }
  if (await el.isDisabled().catch(() => false)) return false;
  const readonly = await el.getAttribute('readonly');
  if (readonly !== null) return false;
  if (onlyIfEmpty) {
    const current = await el.inputValue().catch(() => '');
    if (current && String(current).trim()) return false;
  }
  await el.scrollIntoViewIfNeeded();
  await el.fill(String(value));
  return true;
}

async function checkFirstIfVisible(page, fieldId) {
  const box = page.locator(`input[id^="${fieldId}_"]`).first();
  if (!(await isVisible(box))) return false;
  await box.check({ force: true });
  return true;
}

module.exports = {
  dismissAppModals,
  selectWrapper,
  selectSearchOption,
  selectIfVisible,
  isSelectUnset,
  currentSelectLabel,
  fillById,
  fillIfVisible,
  pickDateIfVisible,
  pickDateInWrapper,
  fillPinCodeSearch,
  checkFirstIfVisible,
  isVisible,
  tryVaahanFetch,
  noteVerifyAddons,
  fillRemainingCustomFields,
  isPlaceholderLabel,
  waitForRealOptions,
  waitForColorList,
  selectColorAfterMake,
  fetchJlrVin,
  fillJlrChassis,
  fillChassisField,
  randomInt,
};

async function fetchJlrVin(page, brand = '') {
  const fromEnv = String(process.env.DMS_VIN || '').trim().toUpperCase();
  if (fromEnv) return fromEnv;

  const result = await page.evaluate(async (makeName) => {
    const http = window.$http;
    const base = window.g && window.g.$base_url_api;
    if (!http || !base) {
      return { chassis: '', error: '$http or g.$base_url_api is missing' };
    }

    const asVin = (raw) => {
      const s = String(raw || '').trim().toUpperCase();
      return /^SA[A-Z0-9]{15}$/.test(s) ? s : '';
    };
    const post = async (url, payload) => {
      try {
        const res = await http('POST', url, payload);
        return { body: res?.body || {} };
      } catch (err) {
        return { body: {}, error: err?.body?.msg || err?.message || 'request failed' };
      }
    };

    // Local / newer deploys expose getJlrVin. Stage may still say Action not found.
    for (const brandName of [makeName || '', '']) {
      const got = await post(`${base}/master-data`, { action: 'getJlrVin', brand: brandName });
      const vin = asVin(got.body?.data?.chassis || got.body?.data?.vin);
      if (vin) return { chassis: vin, via: 'getJlrVin' };
      if (got.error && /action not found/i.test(got.error) && brandName) break;
    }

    // getCollections can call MasterData::getJlrVin even without the action case.
    {
      const got = await post(`${base}/master-data`, {
        action: 'getCollections',
        collections: 'getJlrVin',
      });
      const col = got.body?.data?.getJlrVin || {};
      const vin = asVin(col.list?.chassis || col.chassis || col.list?.[0]?.chassis);
      if (vin) return { chassis: vin, via: 'getCollections' };
    }

    // Admin VIN grid — same master_jlr_total_vins table.
    {
      const got = await post(`${base}/admin/jlr-total-vins`, {
        action: 'list_vins',
        page: 1,
        per_page: 50,
      });
      const rows = Array.isArray(got.body?.data?.rows) ? got.body.data.rows : [];
      const brandRe = makeName ? new RegExp(String(makeName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
      const match = rows.find((row) => asVin(row.chassis) && (!brandRe || brandRe.test(String(row.brand || ''))))
        || rows.find((row) => asVin(row.chassis));
      const vin = asVin(match?.chassis);
      if (vin) return { chassis: vin, via: 'list_vins' };
      if (got.error) return { chassis: '', error: got.error };
    }

    return { chassis: '', error: 'No SA VIN found in master_jlr_total_vins' };
  }, brand).catch((err) => ({ chassis: '', error: err.message }));

  const vin = String(result?.chassis || '').trim().toUpperCase();
  if (vin && result?.via && result.via !== 'getJlrVin') {
    console.log(`  VIN source: ${result.via}`);
  }
  if (!vin && result?.error) {
    console.log(`  getJlrVin failed: ${result.error}`);
  } else if (!vin && result?.msg) {
    console.log(`  getJlrVin: ${result.msg}`);
  }
  return vin;
}

/**
 * add.js binds chassis with :value + @input (not v-model). Playwright fill()
 * can set the DOM and then a later Vue render wipes it from field.value.
 * Write the Pinia field and fire input so the required check sees the VIN.
 */
async function fillChassisField(page, value) {
  const vin = String(value || '').trim().toUpperCase();
  if (!vin) return false;
  const el = page.locator('#chassis').first();
  await el.waitFor({ state: 'visible', timeout: 15000 });
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await el.fill(vin);

  await el.evaluate((node, next) => {
    const app = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const store = pinia?._s?.get('pm');
    if (store?.updateFieldValue) {
      const key = typeof store.getConfigName === 'function'
        ? (store.getConfigName() || 'detailAddConfig')
        : 'detailAddConfig';
      store.updateFieldValue(key, 'chassis', next);
    }
    node.value = next;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, vin);

  const typed = String(await el.inputValue().catch(() => '')).trim().toUpperCase();
  return typed === vin;
}

async function fillJlrChassis(page, makeLabel = '') {
  const chassis = page.locator('#chassis').first();
  await chassis.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (!(await isVisible(chassis))) {
    console.log('  Chassis: field not visible yet');
    return '';
  }

  const make = String(makeLabel || await currentSelectLabel(page, 'make') || '').trim();
  const isJlr = /jaguar|land\s*rover/i.test(make);
  if (!isJlr) {
    const fake = `MAT1234567ABC${Date.now().toString().slice(-4)}`;
    if (!(await fillChassisField(page, fake))) {
      throw new Error(`Could not type chassis ${fake}`);
    }
    console.log(`  Chassis: ${fake} (non-JLR)`);
    return fake;
  }

  const vin = await fetchJlrVin(page, make);
  if (!vin || !/^SA[A-Z0-9]{15}$/.test(vin)) {
    throw new Error(
      'Could not get a 17-character SA VIN from master_jlr_total_vins. '
      + 'Chassis is required for Jaguar / Land Rover — add will not submit without it.',
    );
  }
  if (!(await fillChassisField(page, vin))) {
    throw new Error(`Could not set VIN / Chassis Number to ${vin}`);
  }
  console.log(`  VIN: ${vin} (master_jlr_total_vins, starts with SA)`);
  return vin;
}
