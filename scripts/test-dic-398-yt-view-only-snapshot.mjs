#!/usr/bin/env node
/**
 * Boundary checks for DIC-398: computeYtGrowth() must treat a "view-only"
 * snapshot (subscriberCount null, totalViewCount set) as a real YT snapshot.
 * scrape-yt-stats.js writes such snapshots when YouTube hides the sub count, so
 * filtering on subscriberCount alone dropped their views and view growth.
 */
import assert from 'node:assert/strict';
import { computeYtGrowth } from './build-database.js';

// A trailing view-only snapshot must keep its totalViewCount and view growth,
// while still carrying forward the last known subscriberCount from an earlier
// snapshot (neither metric wipes the other).
{
  const history = [
    { date: '2026-07-01', subscriberCount: 1000, totalViewCount: 500000, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
    { date: '2026-07-08', subscriberCount: null, totalViewCount: 560000, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
  ];
  const stats = computeYtGrowth(history);
  assert.equal(stats.totalViewCount, 560000, 'view-only snapshot view count must survive');
  assert.equal(stats.viewCount_7d, 60000, 'view growth must be computed across the view-only snapshot');
  assert.equal(stats.subscriberCount, 1000, 'last known subscriber count must carry forward');
  assert.equal(stats.date, '2026-07-08', 'date must reflect the latest YT snapshot');
}

// A history made up entirely of view-only snapshots must still yield views and
// view growth, with a null subscriberCount.
{
  const history = [
    { date: '2026-07-01', subscriberCount: null, totalViewCount: 100, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
    { date: '2026-07-02', subscriberCount: null, totalViewCount: 150, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
  ];
  const stats = computeYtGrowth(history);
  assert.equal(stats.subscriberCount, null, 'no subscriber data → null');
  assert.equal(stats.totalViewCount, 150, 'view-only history must report latest views');
  assert.equal(stats.viewCount_1d, 50, 'view-only history must report view growth');
}

// A trailing subscriber-only snapshot must not wipe the last known view count.
{
  const history = [
    { date: '2026-07-01', subscriberCount: 1000, totalViewCount: 500000, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
    { date: '2026-07-08', subscriberCount: 1200, totalViewCount: null, channelId: 'UC398aaaaaaaaaaaaaaaaaa', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
  ];
  const stats = computeYtGrowth(history);
  assert.equal(stats.subscriberCount, 1200, 'subscriber-only snapshot sub count must survive');
  assert.equal(stats.subscriberGrowth_7d, 200, 'subscriber growth must be computed');
  assert.equal(stats.totalViewCount, 500000, 'last known view count must carry forward');
}

// A trailing news-only blank snapshot (both counts null) must not wipe YT stats.
{
  const history = [
    { date: '2026-07-01', subscriberCount: 1000, totalViewCount: 500000 },
    { date: '2026-07-08', subscriberCount: null, totalViewCount: null, newsCount: 3 },
  ];
  const stats = computeYtGrowth(history);
  assert.equal(stats.subscriberCount, 1000, 'blank snapshot must not wipe subscriber count');
  assert.equal(stats.totalViewCount, 500000, 'blank snapshot must not wipe view count');
  assert.equal(stats.newsCount, 3, 'news count still read from the news-only snapshot');
}

console.log('DIC-398 view-only snapshot boundary tests passed ✓');
