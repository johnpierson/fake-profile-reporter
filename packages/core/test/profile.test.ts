import { describe, expect, test } from 'bun:test';
import { captureProfile, diffProfileFacts, observeProfile, estimateJoinedAt, extractProfileFacts, memberIdFromProfileId, parseAbout, parseCountText, postTimestampMs, rscTexts } from '../src/linkedin';
import { scoreProfile } from '../src/scam';
import { DAY, fakeSnapshot, postIdAt, profileIdFor } from './fixtures';

const NOW = Date.UTC(2026, 10, 17);

describe('ids', () => {
  test('member ID round-trips through a profile ID', () => {
    for (const id of [1, 251_749_025, 810_000_000, 4_000_000_000]) {
      expect(memberIdFromProfileId(profileIdFor(id))).toBe(id);
    }
  });

  test('rejects junk profile IDs', () => {
    expect(memberIdFromProfileId('')).toBeNull();
    expect(memberIdFromProfileId('not an id!')).toBeNull();
    expect(memberIdFromProfileId('ACoAA')).toBeNull();
  });

  test('post IDs encode their creation time', () => {
    const t = Date.UTC(2026, 10, 14, 18, 11, 59, 974);
    expect(postTimestampMs(postIdAt(t))).toBe(t);
  });
});

test('estimateJoinedAt interpolates between calibration points', () => {
  expect(new Date(estimateJoinedAt(251_749_025, NOW)!).toISOString().slice(0, 7)).toBe('2013-05');
  const mid = estimateJoinedAt(531_000_000, NOW)!;
  expect(mid).toBeGreaterThan(Date.UTC(2016, 0, 1));
  expect(mid).toBeLessThan(Date.UTC(2017, 11, 31));
  expect(estimateJoinedAt(1, NOW)).toBe(Date.UTC(2003, 4, 5)); // member 1 = launch
  expect(estimateJoinedAt(9_000_000_000, NOW)).toBeLessThan(NOW); // never in the future
});

describe('rsc', () => {
  test('rscTexts skips references and decodes escapes', () => {
    const s = '0:["$","p",null,{"children":["$L1"]}]\n1:["$","p",null,{"children":["Alex doesn\\u2019t have any"]}]';
    expect(rscTexts(s)).toEqual(['Alex doesn’t have any']);
  });

  test('parseCountText', () => {
    expect(parseCountText('500+ connections', 'connections')).toEqual({ count: 500, capped: true });
    expect(parseCountText('1 connection', 'connections')).toEqual({ count: 1, capped: false });
    expect(parseCountText('40,830,057 followers', 'followers')).toEqual({ count: 40_830_057, capped: false });
    expect(parseCountText('no numbers here', 'followers')).toBeNull();
  });

  test('parseAbout reads join date and verifications', () => {
    const s = fakeSnapshot({ joinedAt: Date.UTC(2013, 4, 15), verifications: [['Identity', 'Verified by LinkedIn in April 2026']] });
    const a = parseAbout(s.payloads.about!);
    expect(new Date(a.joinedAt!).toISOString().slice(0, 7)).toBe('2013-05');
    expect(a.verifications).toEqual(['Identity: Verified by LinkedIn in April 2026']);
    expect(parseAbout(fakeSnapshot().payloads.about!).verifications).toEqual([]);
  });
});

describe('extractProfileFacts', () => {
  test('extracts identity, history, counts, and activity', () => {
    const f = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, postTimes: [Date.UTC(2026, 9, 1), Date.UTC(2026, 5, 1)] }), NOW);
    expect(f.memberId).toBe(700_000_123);
    expect(f.slug).toBe('jordan-sample-0a1b2c');
    expect(f.geoName).toBe('Springfield, United States');
    expect(f.industry).toBe('Software Development');
    expect(f.positions).toEqual([{ title: 'Software Engineer', company: 'Example Corp', companyId: null, start: { year: 2018, month: 1 }, end: null }]);
    expect(f.photo).toEqual({ present: true, uploadedAt: 1_600_000_000_000 });
    expect(f.connections).toEqual({ count: 500, capped: true });
    expect(f.followers).toBe(300);
    expect(f.joined?.source).toBe('about');
    expect(f.activity).toEqual({ postCount: 2, newestAt: Date.UTC(2026, 9, 1), oldestAt: Date.UTC(2026, 5, 1) });
  });

  test('falls back to a member-ID join estimate without the About payload', () => {
    const f = extractProfileFacts(fakeSnapshot({ memberId: 251_749_025, joinedAt: null }), NOW);
    expect(f.joined?.source).toBe('memberId');
    expect(f.about).toBeNull();
  });

  test('survives a snapshot where every request failed', () => {
    const f = extractProfileFacts({ schema: 1, capturedAt: NOW, slug: 'x', profileId: null, payloads: {}, errors: { fullProfile: 'HTTP 500' } }, NOW);
    expect(f.memberId).toBeNull();
    expect(f.positions).toEqual([]);
  });
});

test('diffProfileFacts reports slug, headline, and connection changes', () => {
  const a = extractProfileFacts(fakeSnapshot({ slug: 'old-slug', connections: '12 connections' }), NOW);
  const b = extractProfileFacts(fakeSnapshot({ slug: 'new-slug', headline: 'CEO', connections: '40 connections' }), NOW);
  expect(diffProfileFacts(a, b).map((c) => c.field).sort()).toEqual(['connections', 'headline', 'slug']);
  expect(diffProfileFacts(a, a)).toEqual([]);
});

test('observeProfile keeps the last good values for parts that failed', () => {
  const good = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, headline: 'Engineer' }), NOW);
  const failed = { ...good, profileLoaded: false, headline: null, firstName: null, positions: [], about: null, connections: null };
  const carried = observeProfile(good, failed).current;
  expect(carried).toMatchObject({ profileLoaded: true, headline: 'Engineer', firstName: good.firstName, about: good.about, connections: good.connections });
  // A change made after the failed capture is still reported against the carried baseline.
  const later = { ...good, headline: 'CEO' };
  expect(diffProfileFacts(carried, later).map((c) => c.field)).toEqual(['headline']);
});

test('a failed About read keeps the join date LinkedIn gave, not the member-ID estimate', () => {
  const good = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, joinedAt: Date.UTC(2026, 6, 15) }), NOW);
  const snap = fakeSnapshot({ memberId: 700_000_123 });
  delete snap.payloads.about;
  const failed = extractProfileFacts(snap, NOW);
  expect(failed.joined?.source).toBe('memberId');
  const { current, changes } = observeProfile(good, failed);
  expect(current.joined).toEqual({ at: Date.UTC(2026, 6, 15), source: 'about' });
  expect(changes).toEqual([]);
  expect(scoreProfile(current, NOW).score).toBe(scoreProfile(good, NOW).score);
});

test('observeProfile names the parts it carried forward', () => {
  const good = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123 }), NOW);
  const snap = fakeSnapshot({ memberId: 700_000_123, connections: null });
  delete snap.payloads.fullProfile;
  delete snap.payloads.about;
  expect(observeProfile(good, extractProfileFacts(snap, NOW)).carried).toEqual(['profile', 'about', 'connections']);
});

test('an account joined this month never has a negative age', () => {
  const f = extractProfileFacts(fakeSnapshot({ joinedAt: NOW + 30 * DAY }), NOW); // next month: shown mid-month, after NOW
  const age = scoreProfile(f, NOW).signals.find((x) => x.id === 'age.new');
  expect(age?.label).toContain('(0 days)');
});

test('entities without a URN never stand in for a missing location or industry', () => {
  const snap = fakeSnapshot();
  const included = (snap.payloads.fullProfile as any).included as any[];
  const p = included.find((e) => e.$type?.endsWith('.Profile'));
  delete p.geoLocation;
  delete p.industryUrn;
  included.push({ $type: 'x.Stray', name: 'Stray Industry', defaultLocalizedName: 'Stray Place' });
  const f = extractProfileFacts(snap, NOW);
  expect(f.geoName).toBeNull();
  expect(f.industry).toBeNull();
});

test('malformed nested payloads parse to empty facts instead of throwing', () => {
  for (const payloads of [
    { resolve: { included: 'x' }, fullProfile: { included: {} } },
    { resolve: { included: [{ entityUrn: 123 }] }, fullProfile: { included: [null, 7, { $type: 'x.identity.profile.Profile', entityUrn: 5, firstName: {} }] } },
  ]) {
    const f = extractProfileFacts({ schema: 1, capturedAt: NOW, slug: 'x', profileId: null, payloads: payloads as any, errors: {} }, NOW);
    expect(f.memberId).toBeNull();
    expect(f.firstName).toBeNull();
  }
});

test('diffProfileFacts ignores parts that failed to load', () => {
  const a = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123 }), NOW);
  const failed = { ...a, profileLoaded: false, headline: null, positions: [], about: null, connections: null };
  expect(diffProfileFacts(a, failed)).toEqual([]);
  expect(diffProfileFacts(failed, a)).toEqual([]);
});

describe('extractProfileFacts profile selection', () => {
  test('uses the requested profile when the payload bundles other people first', () => {
    const f = extractProfileFacts(fakeSnapshot({ strangers: 3 }), NOW);
    expect(f.slug).toBe('jordan-sample-0a1b2c');
    expect(f.firstName).toBe('Jordan');
    expect(f.positions.map((p) => p.company)).toEqual(['Example Corp']);
  });
});

describe('scoreProfile', () => {
  test('an established, verified, active account scores low', () => {
    const s = scoreProfile(
      extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2012, 0, 15), verifications: [['Identity', 'Verified by LinkedIn in May 2025']] }), NOW),
      NOW,
    );
    expect(s.score).toBe(0);
    expect(s.level).toBe('low');
  });

  test('a brand-new, empty "recruiter" with no network scores high', () => {
    const s = scoreProfile(
      extractProfileFacts(
        fakeSnapshot({
          joinedAt: NOW - 10 * DAY,
          headline: 'Senior Talent Acquisition Director | Hiring now, DM me',
          summary: null,
          photoUploadedAt: null,
          positions: [{ title: 'Director', company: 'Big Tech', startYear: 2012 }],
          educations: 0,
          skills: 0,
          connections: '3 connections',
          postTimes: [],
        }),
        NOW,
      ),
      NOW,
    );
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['age.new', 'connections.tiny', 'pattern.senior-no-network', 'pattern.career-vs-age', 'activity.none', 'photo.none']) {
      expect(ids).toContain(id);
    }
  });

  test('a months-old recruiter persona with a long big-company career scores high', () => {
    // Shape of a reported fake recruiter: complete-looking profile, nothing behind it.
    const s = scoreProfile(
      extractProfileFacts(
        fakeSnapshot({
          joinedAt: NOW - 120 * DAY,
          headline: 'Human Resources & Business Management Leader | Talent Development',
          summary: null,
          positions: [
            { title: 'HR & Business Management Leader', company: 'Example Corp', startYear: 2020, companyId: 111 },
            { title: 'HR Manager', company: 'Sample Systems', startYear: 2016, endYear: 2020, companyId: 222 },
            { title: 'HR Manager', company: 'Demo Labs', startYear: 2009, endYear: 2016, companyId: 333 },
          ],
          skills: 20,
          connections: null,
          followers: 770,
          postTimes: [],
        }),
        NOW,
      ),
      NOW,
    );
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['age.recent', 'pattern.career-vs-age', 'pattern.recruiter-new', 'pattern.employer-unverified', 'pattern.followers-no-activity']) {
      expect(ids).toContain(id);
    }
  });

  test('workplace verification for the claimed employer clears the employer signal', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        joinedAt: NOW - 300 * DAY,
        positions: [{ title: 'Recruiter', company: 'Example Corp', startYear: 2024, companyId: 111 }],
        verifications: [['Example Corp', 'Verified using work email in March 2026']],
      }),
      NOW,
    );
    const ids = scoreProfile(f, NOW).signals.map((x) => x.id);
    expect(ids).not.toContain('pattern.employer-unverified');
    expect(ids).not.toContain('pattern.recruiter-new');
  });

  test('missing evidence is listed, not scored', () => {
    const f = extractProfileFacts(fakeSnapshot({ connections: null, headline: 'Engineer', summary: null }), NOW);
    const s = scoreProfile({ ...f, profileLoaded: false, positions: [], educations: [], skills: [], about: null, joined: null, activity: null }, NOW);
    expect(s.signals.filter((x) => x.weight > 0)).toEqual([]);
    expect(s.missing.length).toBe(5);
  });

  test('a strong discrepancy keeps the level at least medium', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        joinedAt: NOW - 200 * DAY,
        positions: [{ title: 'Engineer', company: 'Example Corp', startYear: 2010 }],
        verifications: [['Identity', 'Verified by LinkedIn in May 2026']],
        followers: 20_000,
      }),
      NOW,
    );
    const s = scoreProfile({ ...f, influencer: true }, NOW);
    expect(s.signals.find((x) => x.id === 'pattern.career-vs-age')?.kind).toBe('discrepancy');
    expect(s.score).toBeLessThan(35);
    expect(s.level).toBe('medium');
  });

  test('an old faceless, inactive account is flagged as a possible shell', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2011, 6, 15), photoUploadedAt: null, postTimes: [] }), NOW);
    const ids = scoreProfile(f, NOW).signals.map((x) => x.id);
    expect(ids).toContain('aged.shell');
    expect(ids).not.toContain('aged.refreshed');
  });

  test('an old inactive account with freshly changed contact info is flagged as refreshed', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2014, 2, 15), postTimes: [] }), NOW);
    const s = scoreProfile({ ...f, about: { ...f.about!, contactInfoUpdated: 'Updated less than 6 months ago' } }, NOW);
    expect(s.signals.find((x) => x.id === 'aged.refreshed')?.label).toContain('contact info');
  });

  test('aged-account checks leave active accounts alone', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2011, 6, 15), photoUploadedAt: null, postTimes: [NOW - 30 * DAY] }), NOW);
    const ids = scoreProfile({ ...f, about: { ...f.about!, contactInfoUpdated: 'Updated less than 6 months ago' } }, NOW).signals.map((x) => x.id);
    expect(ids.filter((id) => id.startsWith('aged.'))).toEqual([]);
  });

  test('an old account re-dressed for a new persona reads as possibly resold', () => {
    const base = extractProfileFacts(
      fakeSnapshot({
        slug: 'sam-q-48213907',
        lastName: 'Q.',
        headline: 'Senior AI Software Engineer | Full-Stack | Cloud',
        joinedAt: Date.UTC(2010, 7, 15),
        photoUploadedAt: null,
        postTimes: [],
        verifications: [['Example Corp', 'Verified using work email in March 2019']],
      }),
      NOW,
    );
    const f = { ...base, industry: 'Security & Investigations', background: { present: true, uploadedAt: NOW - 20 * DAY } };
    const s = scoreProfile(f, NOW);
    const byId = Object.fromEntries(s.signals.map((x) => [x.id, x]));
    expect(byId['pattern.aged-resale']?.label).toContain('industry left over');
    expect(byId['pattern.aged-resale']?.weight).toBe(24); // five signs
    expect(byId['aged.refreshed']?.label).toContain('banner');
    expect(byId['profile.short-name']).toBeDefined();
    // The trust a resold account would carry over is discounted.
    expect(byId['age.established']?.weight).toBe(0);
    expect(byId['verified.other']?.weight).toBe(-6);
    expect(s.level).not.toBe('low');
  });

  test('a long-standing, lived-in account keeps its trust', () => {
    const f = extractProfileFacts(
      fakeSnapshot({ slug: 'sam-quinn-48213907', joinedAt: Date.UTC(2010, 7, 15), postTimes: [NOW - 10 * DAY], verifications: [['Example Corp', 'Verified using work email in March 2019']] }),
      NOW,
    );
    const s = scoreProfile({ ...f, industry: 'Investment Banking' }, NOW);
    const ids = s.signals.map((x) => x.id);
    expect(ids.filter((id) => id.startsWith('aged.') || id === 'pattern.aged-resale')).toEqual([]);
    expect(s.signals.find((x) => x.id === 'age.established')?.weight).toBe(-8);
    expect(s.signals.find((x) => x.id === 'verified.other')?.weight).toBe(-12);
  });

  test('one or two resale signs alone are not a pattern', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2010, 7, 15), photoUploadedAt: null, postTimes: [] }), NOW);
    const ids = scoreProfile(f, NOW).signals.map((x) => x.id);
    expect(ids).toContain('aged.shell');
    expect(ids).not.toContain('pattern.aged-resale');
  });

  test('a recruiter is not penalized for verifications that were never read', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: null, headline: 'Senior Recruiter' }), NOW);
    const ids = scoreProfile({ ...f, about: null, joined: { at: NOW - 100 * DAY, source: 'memberId' } }, NOW).signals.map((x) => x.id);
    expect(ids).not.toContain('pattern.recruiter-new');
    expect(ids).not.toContain('pattern.recruiter-unverified');
  });

  test('a photo hidden from this viewer is not checked, not missing', () => {
    const f = extractProfileFacts(fakeSnapshot({ photoHidden: true, joinedAt: Date.UTC(2010, 7, 15), postTimes: [] }), NOW);
    expect(f.photo).toBeNull();
    const s = scoreProfile(f, NOW);
    const ids = s.signals.map((x) => x.id);
    expect(ids).not.toContain('photo.none');
    expect(ids).not.toContain('aged.shell');
    expect(s.missing).toContain('Profile photo (hidden from your account)');
    expect(extractProfileFacts(fakeSnapshot({ photoUploadedAt: null }), NOW).photo).toEqual({ present: false, uploadedAt: null });
  });

  for (const [name, postTimes, activityId] of [
    ['no public posts', [], 'activity.none'],
    ['only a stale post', [NOW - 400 * DAY], 'activity.stale'],
  ] as const) {
    test(`a verified long-tenure senior with ${name} stays low`, () => {
      const f = extractProfileFacts(
        fakeSnapshot({
          slug: 'riley-okafor',
          firstName: 'Riley',
          lastName: 'Okafor',
          headline: 'Senior Director of Platform Engineering at Example Corp',
          summary: 'I lead platform teams that keep deploys boring and on-call quiet.',
          joinedAt: Date.UTC(2012, 3, 15),
          verifications: [['Identity', 'Verified by LinkedIn in May 2025']],
          positions: [
            { title: 'Senior Director of Platform Engineering', company: 'Example Corp', startYear: 2019 },
            { title: 'Engineering Manager', company: 'Sample Systems', startYear: 2011, endYear: 2019 },
          ],
          postTimes: [...postTimes],
        }),
        NOW,
      );
      const s = scoreProfile(f, NOW);
      expect(s.level).toBe('low');
      const ids = s.signals.map((x) => x.id);
      expect(ids).toContain(activityId);
      for (const id of ['pattern.senior-no-network', 'pattern.career-vs-age', 'pattern.aged-resale', 'aged.shell']) {
        expect(ids).not.toContain(id);
      }
    });
  }

  test('a brand-new intern with a real footprint is medium on weak signals only', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        slug: 'casey-nguyen',
        firstName: 'Casey',
        lastName: 'Nguyen',
        headline: 'Software Engineering Intern at Example Corp',
        summary: 'Computer science student who enjoys building small web apps and learning from code review.',
        joinedAt: NOW - 5 * DAY,
        positions: [{ title: 'Software Engineering Intern', company: 'Example Corp', startYear: 2026 }],
        connections: '80 connections',
        followers: 40,
        postTimes: [NOW - 2 * DAY],
      }),
      NOW,
    );
    const s = scoreProfile(f, NOW);
    expect(s.level).toBe('medium');
    const ids = s.signals.map((x) => x.id);
    expect(ids).toContain('age.new');
    for (const id of ['pattern.recruiter-new', 'pattern.senior-no-network', 'pattern.career-vs-age', 'pattern.followers-no-activity']) {
      expect(ids).not.toContain(id);
    }
    expect(s.signals.filter((x) => x.weight > 0).every((x) => x.kind === 'weak')).toBe(true);
  });

  // Same-month intern, ~40 connections, no posts, linked company page: weak
  // signals stack with pattern.employer-unverified and it scores high (~72).
  test.todo('a thinner brand-new intern with a linked employer page is not high');

  test('a polished new recruiter persona with a photo and an About still scores high', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        slug: 'morgan-reyes',
        firstName: 'Morgan',
        lastName: 'Reyes',
        headline: 'Technical Recruiter at Example Corp',
        summary: 'Matching great engineers with great teams.',
        joinedAt: NOW - 45 * DAY,
        positions: [{ title: 'Technical Recruiter', company: 'Example Corp', startYear: 2025, companyId: 111 }],
        connections: '18 connections',
        followers: 60,
        postTimes: [],
      }),
      NOW,
    );
    const s = scoreProfile(f, NOW);
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['age.recent', 'pattern.recruiter-new', 'connections.few']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('photo.none');
  });

  test('resale needs three signs on an account at least three years old', () => {
    const YEAR = 365.25 * DAY;
    // Default slug, no photo, never posted, non-tech industry under a tech headline.
    const resaleLooking = (joinedAt: number) => {
      const f = extractProfileFacts(fakeSnapshot({ joinedAt, photoUploadedAt: null, postTimes: [] }), NOW);
      return scoreProfile({ ...f, industry: 'Security & Investigations' }, NOW);
    };

    const old = resaleLooking(Date.UTC(2018, 2, 15));
    const resale = old.signals.find((x) => x.id === 'pattern.aged-resale');
    expect(resale?.weight).toBe(12); // three signs
    for (const sign of ['no photo, never posted', 'default URL', 'industry left over']) {
      expect(resale?.label).toContain(sign);
    }
    expect(old.level).toBe('medium');

    const ids = resaleLooking(NOW - 3 * YEAR + 30 * DAY).signals.map((x) => x.id);
    expect(ids.filter((id) => id.startsWith('aged.') || id === 'pattern.aged-resale')).toEqual([]);
  });

  test('a hidden photo is not a resale sign, but the other signs still count', () => {
    const f = extractProfileFacts(fakeSnapshot({ photoHidden: true, joinedAt: Date.UTC(2010, 7, 15), postTimes: [] }), NOW);
    const s = scoreProfile({ ...f, industry: 'Security & Investigations', background: { present: true, uploadedAt: NOW - 20 * DAY } }, NOW);
    const ids = s.signals.map((x) => x.id);
    const resale = s.signals.find((x) => x.id === 'pattern.aged-resale');
    expect(resale).toBeDefined();
    expect(resale?.label).not.toContain('no photo, never posted');
    expect(ids).not.toContain('photo.none');
    expect(ids).not.toContain('aged.shell');
    expect(s.missing).toContain('Profile photo (hidden from your account)');
  });

  test('word-list terms count only as whole words', () => {
    const textIds = (headline: string, summary: string) =>
      scoreProfile(extractProfileFacts(fakeSnapshot({ slug: 'avery-park', headline, summary }), NOW), NOW)
        .signals.map((x) => x.id)
        .filter((id) => id.startsWith('text.'));
    expect(textIds('Applied cryptography and defined APIs at Coinbase', 'Coaching teams; mentorship programs. Built token-based auth.')).toEqual([]);
    expect(textIds('Web3 and DeFi builder, NFT collector', 'Passionate about helping businesses. Let’s connect!').sort()).toEqual(['text.buzz', 'text.crypto']);
  });

  test('member-ID age estimates count for half', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: null }), NOW);
    const sig = scoreProfile({ ...f, joined: { at: NOW - 10 * DAY, source: 'memberId' } }, NOW).signals.find((x) => x.id === 'age.new');
    expect(sig?.weight).toBe(17.5);
  });
});

test('captureProfile makes the expected requests and assembles a snapshot', async () => {
  const fixture = fakeSnapshot();
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    const p = fixture.payloads;
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes('graphql')) return json(p.resolve);
    if (url.includes('dash/profiles')) return json(p.fullProfile);
    if (url.includes('followingStates')) return json(p.followingState);
    if (url.includes('ProfileVerificationDetailsDialog')) return new Response(p.about);
    if (url.includes('profileCardsActivity')) return new Response(p.activity);
    if (url.startsWith('/in/')) return new Response(
        // Real markup splits the number from the word.
        '<p class="a">300 followers</p><span>·</span><p class="b">500+</p></div><a href="#"><p class="c">connections</p>' +
          '<span><strong>Sam</strong> are mutual connections</span>',
      );
    return new Response('nope', { status: 404 });
  }) as typeof fetch;

  const snap = await captureProfile('jordan-sample-0a1b2c', { fetch: fakeFetch, csrf: 'ajax:test' });
  expect(snap.errors).toEqual({});
  expect(snap.profileId).toBe(fixture.profileId);
  expect(snap.payloads.profilePageCounts).toEqual(['300 followers', '500+ connections']);
  expect(calls).toHaveLength(6);
  expect(extractProfileFacts(snap, NOW).memberId).toBe(700_000_001);
});
