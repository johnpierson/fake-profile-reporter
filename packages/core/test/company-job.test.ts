import { describe, expect, test } from 'bun:test';
import { companyHtml, jobHtml } from './pages';
import { byClass, compactJobFacts, diffJobFacts, parseAgo, parseCount, parseCompanyPage, siteDomain, extractContacts, parseJobPosting, parseSalary, linkedInTarget } from '../src/linkedin';
import { scoreCompany, scoreJob } from '../src/scam';

const NOW = Date.UTC(2026, 10, 18);
const DAY = 86_400_000;

describe('html helpers', () => {
  test('class matching is by whole token', () => {
    const html = '<div class="salary-range">A</div><div class="x salary y">B</div>';
    expect(byClass(html, 'salary')).toEqual(['B']);
  });
  test('counts and relative times', () => {
    expect(parseCount('418,670 followers')).toBe(418670);
    expect(parseCount('12K')).toBe(12000);
    expect(parseAgo('Reposted 2 weeks ago', NOW)).toBe(NOW - 14 * DAY);
    expect(parseAgo('just now', NOW)).toBeNull();
  });
});

describe('linkedInTarget', () => {
  test('recognizes profiles, companies and jobs', () => {
    expect(linkedInTarget('https://www.linkedin.com/in/jordan-sample/')).toEqual({ kind: 'profile', slug: 'jordan-sample' });
    expect(linkedInTarget('https://www.linkedin.com/company/example-co/about/')).toEqual({ kind: 'company', slug: 'example-co' });
    expect(linkedInTarget('https://www.linkedin.com/jobs/view/support-specialist-at-example-4400000001/')).toEqual({ kind: 'job', id: '4400000001' });
    expect(linkedInTarget('https://www.linkedin.com/jobs/search/?currentJobId=4400000002&keywords=x')).toEqual({ kind: 'job', id: '4400000002' });
    expect(linkedInTarget('https://www.linkedin.com/feed/')).toBeNull();
    expect(linkedInTarget('https://example.com/in/x')).toBeNull();
  });
});

describe('company pages', () => {
  test('parses the public page', () => {
    const c = parseCompanyPage(companyHtml({}), 'example-co');
    expect(c).toMatchObject({
      companyId: 123456,
      name: 'Example Co',
      followers: 1200,
      employeesOnLinkedIn: 120,
      claimedSize: { min: 51, max: 200 },
      website: 'https://www.example.com',
      industry: 'Software Development',
      foundedYear: 2009,
      posts: { count: 1 },
    });
    expect(c.specialties).toEqual(['Widgets', 'Gadgets', 'Research and Development']);
    expect(siteDomain(c.website)).toBe('example.com');
  });

  test('an established page scores low', () => {
    const s = scoreCompany(parseCompanyPage(companyHtml({ followers: '25,000' }), 'example-co'), NOW);
    expect(s.level).toBe('low');
    expect(s.signals.some((x) => x.id === 'company.employees')).toBe(true);
  });

  test('a big claim with nobody behind it, on a hiring-style name, scores high', () => {
    const c = parseCompanyPage(
      companyHtml({ name: 'Example Brand Careers', followers: '14', employees: 2, size: '1,001-5,000 employees', website: 'https://examplebrand.wixsite.com/jobs', posts: [], logoAt: null }),
      'example-brand-careers',
    );
    const s = scoreCompany(c, NOW);
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['company.size-mismatch', 'company.hiring-name', 'company.free-website', 'company.few-followers', 'company.no-logo']) {
      expect(ids).toContain(id);
    }
  });

  test('staffing firms are not flagged for recruiting names', () => {
    const c = parseCompanyPage(companyHtml({ name: 'Acme Recruiting', industry: 'Staffing and Recruiting' }), 'acme-recruiting');
    expect(scoreCompany(c, NOW).signals.map((x) => x.id)).not.toContain('company.hiring-name');
  });

  test('a mid-size claim needs at least three people behind it', () => {
    const two = scoreCompany(parseCompanyPage(companyHtml({ employees: 2 }), 'example-co'), NOW);
    expect(two.signals.map((x) => x.id)).toContain('company.size-mismatch');
    expect(two.level).toBe('medium'); // the discrepancy lifts a low score
    const four = scoreCompany(parseCompanyPage(companyHtml({ employees: 4 }), 'example-co'), NOW);
    expect(four.signals.map((x) => x.id)).not.toContain('company.size-mismatch');
  });

  test('a self-employed page claiming 51-200 employees is a discrepancy', () => {
    const c = parseCompanyPage(companyHtml({}), 'example-co');
    expect(scoreCompany({ ...c, type: 'Self-Employed' }, NOW).signals.map((x) => x.id)).toContain('company.self-employed-large');
  });

  test('a fresh logo on a long-founded company is flagged', () => {
    const c = parseCompanyPage(companyHtml({ founded: 2010, logoAt: NOW - 20 * DAY }), 'example-co');
    expect(scoreCompany(c, NOW).signals.map((x) => x.id)).toContain('company.new-logo');
  });

  test('unread page details are missing, but a missing website is observed', () => {
    const s = scoreCompany(parseCompanyPage(companyHtml({ employees: null, founded: null, size: null, website: null }), 'example-co'), NOW);
    for (const m of ['Employees on LinkedIn', 'Founding year', 'Company size']) expect(s.missing).toContain(m);
    const ids = s.signals.filter((x) => x.weight > 0).map((x) => x.id);
    for (const id of ['company.size-mismatch', 'company.no-employees', 'company.few-employees', 'company.new-logo', 'company.self-employed-large']) {
      expect(ids).not.toContain(id);
    }
    expect(s.signals.find((x) => x.id === 'company.no-website')?.kind).toBe('weak');
  });
});

describe('job postings', () => {
  const company = parseCompanyPage(companyHtml({ followers: '25,000' }), 'example-co');
  const companyScore = scoreCompany(company, NOW);

  test('parses the public posting', () => {
    const j = parseJobPosting(jobHtml({}), '4400000001', NOW);
    expect(j).toMatchObject({
      title: 'Customer Support Specialist',
      company: { name: 'Example Co', slug: 'example-co' },
      location: 'Remote',
      postedAt: NOW - 3 * DAY,
      applicants: { count: 200, over: true },
      seniority: 'Entry level',
      employmentType: 'Full-time',
      salary: { text: '$20.00/hr - $24.00/hr', min: 20, max: 24, period: 'hour' },
      apply: 'easy',
    });
  });

  test('an ordinary posting from an established company scores low', () => {
    const j = parseJobPosting(jobHtml({}), '1', NOW);
    expect(scoreJob(j, company, companyScore).level).toBe('low');
  });

  test('chat apps, personal email and equipment checks score high', () => {
    const j = parseJobPosting(
      jobHtml({
        title: 'Remote Data Entry Clerk',
        salary: '$45.00/hr - $60.00/hr',
        description:
          '<p>No experience required! Interview will be conducted via Telegram. We will send you a check to purchase equipment for your home office. Send your resume to hiring.team.example@gmail.com</p>',
      }),
      '2',
      NOW,
    );
    const s = scoreJob(j, company, companyScore);
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['job.chat-app', 'job.pay-to-work', 'job.personal-email', 'job.no-experience', 'job.too-good', 'job.chat-interview']) {
      expect(ids).toContain(id);
    }
  });

  test('an email on another company domain is a discrepancy', () => {
    const j = parseJobPosting(jobHtml({ description: '<p>Apply by emailing jobs@example-co-hr.net with your resume and availability for a short call this week. '.padEnd(500, 'x') + '</p>' }), '3', NOW);
    expect(scoreJob(j, company, companyScore).signals.map((x) => x.id)).toContain('job.email-domain');
  });

  test('a posting with no company page, or a suspicious one, is flagged', () => {
    const orphan = parseJobPosting(jobHtml({ slug: null }), '4', NOW);
    expect(scoreJob(orphan, null, null).signals.map((x) => x.id)).toContain('job.no-company-page');

    const shady = parseCompanyPage(companyHtml({ name: 'Brand Hiring', followers: '9', employees: 1, size: '5,001-10,000 employees', website: null, posts: [] }), 'brand-hiring');
    const j = parseJobPosting(jobHtml({ slug: 'brand-hiring', company: 'Brand Hiring' }), '5', NOW);
    const s = scoreJob(j, shady, scoreCompany(shady, NOW));
    expect(s.signals.find((x) => x.id === 'job.company-suspicious')?.kind).toBe('discrepancy');
  });

  for (const [id, description] of [
    [
      'job.reshipping',
      '<p>As a Logistics Coordinator you will receive and inspect packages delivered to your home, photograph the contents, and reship them to our regional partners using the prepaid labels we email each morning. You will keep a simple log of tracking numbers and report any damaged items to your supervisor. The role is fully remote, hours are flexible, and we provide a short onboarding call to walk you through the process and our reporting templates.</p>',
    ],
    [
      'job.money-transfer',
      '<p>As a Client Payments Coordinator you will process payments on behalf of our overseas customers and transfer funds to our suppliers within one business day. You will reconcile each transaction in a shared spreadsheet, confirm receipt with the accounts team, and keep clear records for the monthly audit. The role is fully remote, hours are flexible, and we provide a short onboarding call to walk you through our banking partners and reporting templates.</p>',
    ],
  ] as const) {
    test(`${id} is a discrepancy that keeps the level at least medium`, () => {
      const j = parseJobPosting(jobHtml({ description }), '6', NOW);
      expect(j.description.length).toBeGreaterThanOrEqual(400);
      const s = scoreJob(j, company, companyScore);
      expect(s.signals.find((x) => x.id === id)?.kind).toBe('discrepancy');
      expect(s.level).not.toBe('low');
    });
  }

  test('a posting naming another company than its linked page is flagged', () => {
    const j = parseJobPosting(jobHtml({ slug: 'example-co', company: 'Northwind Traders' }), '7', NOW);
    expect(scoreJob(j, company, companyScore).signals.map((x) => x.id)).toContain('job.company-name-mismatch');
  });

  test('job descriptions are compared by digest', () => {
    const a = parseJobPosting(jobHtml({}), '1', NOW);
    const b = parseJobPosting(jobHtml({ description: '<p>Something else entirely, rewritten. '.padEnd(500, 'y') + '</p>' }), '1', NOW);
    expect(compactJobFacts(a).description).toMatch(/^digest:/);
    expect(diffJobFacts(compactJobFacts(a), a)).toEqual([]);
    expect(diffJobFacts(compactJobFacts(a), b).map((c) => c.field)).toEqual(['description']);
  });

  test('salary and contact extraction', () => {
    expect(parseSalary('$36,000.00/yr - $150,000.00/yr')).toEqual({ text: '$36,000.00/yr - $150,000.00/yr', min: 36000, max: 150000, period: 'year' });
    expect(extractContacts('Call +1 (555) 010-2000 or mail A@B.example')).toEqual({ emails: ['a@b.example'], phones: ['+1 (555) 010-2000'], urls: [] });
  });
});
