import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewardMetadata } from '../src/contracts/contractService.js';

test('buildRewardMetadata includes the requested activity fields', () => {
  const metadata = buildRewardMetadata({
    activity: {
      id: '1785332168203850',
      category: 'mixed',
      location: 'Goa, India',
      quantity: '10.00',
      timestamp: 1785332195,
      volunteers: 50,
      contributorId: '1785312267588'
    },
    label: 'Ocean Cleanup Reward - mixed'
  });

  assert.equal(metadata.label, 'Ocean Cleanup Reward - mixed');
  assert.equal(metadata.category, 'mixed');
  assert.equal(metadata.location, 'Goa, India');
  assert.equal(metadata.quantity, '10.00');
  assert.equal(metadata.timestamp, undefined);
  assert.equal(metadata.activityId, '1785332168203850');
  assert.equal(metadata.volunteers, '50');
  assert.equal(metadata.contributorId, '1785312267588');
});

test('buildRewardMetadata truncates oversized strings for Lucid metadata compatibility', () => {
  const longLocation = 'x'.repeat(80);
  const metadata = buildRewardMetadata({
    activity: {
      id: 'activity-42',
      location: longLocation
    },
    label: 'Ocean Cleanup Reward - mixed'
  });

  assert.equal(metadata.location, longLocation.slice(0, 64));
});

test('buildRewardMetadata serializes boolean verification state for metadata compatibility', () => {
  const metadata = buildRewardMetadata({
    activity: {
      id: 'activity-42',
      verified: true
    },
    label: 'Ocean Cleanup Reward - mixed'
  });

  assert.equal(metadata.verified, 'true');
});

test('buildRewardMetadata converts null verification values to false strings for Lucid compatibility', () => {
  const metadata = buildRewardMetadata({
    activity: {
      verified: null
    },
    label: 'Ocean Cleanup Reward - mixed'
  });

  assert.equal(metadata.verified, 'false');
});

test('buildRewardMetadata derives verified status from approved activities', () => {
  const metadata = buildRewardMetadata({
    activity: {
      status: 'approved'
    },
    label: 'Ocean Cleanup Reward - mixed'
  });

  assert.equal(metadata.verified, 'true');
});
