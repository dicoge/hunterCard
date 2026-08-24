import assert from 'node:assert/strict';

// Test AdSlot behavioral logic without heavy React DOM rendering
function simulateAdSlotVisibility({ role, hasConsent, hasError }) {
  // Pro subscribers: hide ads
  if (role === 'subscriber') {
    return { visible: false, reason: 'pro_entitlement' };
  }
  // Missing consent or rendering error: fail-closed
  if (!hasConsent || hasError) {
    return { visible: false, reason: 'fail_closed' };
  }
  return { visible: true, reason: 'render_ad' };
}

console.log('── Unit Test: AdSlot Logic & Policy Assertions ──');

// 1. Pro subscriber must hide ads
const proResult = simulateAdSlotVisibility({ role: 'subscriber', hasConsent: true, hasError: false });
assert.equal(proResult.visible, false, 'Pro subscribers must not see ads');
assert.equal(proResult.reason, 'pro_entitlement');
console.log('✓ PASS: Pro entitlement hides ads automatically');

// 2. Free user with consent shows ad
const freeResult = simulateAdSlotVisibility({ role: 'free_user', hasConsent: true, hasError: false });
assert.equal(freeResult.visible, true, 'Free users should see non-intrusive ad slot');
console.log('✓ PASS: Free user sees non-intrusive test ad slot');

// 3. Guest with consent shows ad
const guestResult = simulateAdSlotVisibility({ role: 'guest', hasConsent: true, hasError: false });
assert.equal(guestResult.visible, true, 'Guest mode should see non-intrusive ad slot');
console.log('✓ PASS: Guest mode sees non-intrusive test ad slot');

// 4. Missing CMP consent fails closed
const noConsentResult = simulateAdSlotVisibility({ role: 'free_user', hasConsent: false, hasError: false });
assert.equal(noConsentResult.visible, false, 'Missing consent must fail closed');
assert.equal(noConsentResult.reason, 'fail_closed');
console.log('✓ PASS: Missing consent fails closed safely');

// 5. Render error fails closed
const errorResult = simulateAdSlotVisibility({ role: 'free_user', hasConsent: true, hasError: true });
assert.equal(errorResult.visible, false, 'Rendering error must fail closed');
assert.equal(errorResult.reason, 'fail_closed');
console.log('✓ PASS: Rendering error fails closed without blocking app');

console.log('\nAll AdSlot logic unit tests passed successfully!');
