const GITHUB_API = "https://api.github.com";

const clip = (value, size) => String(value || "").replace(/\s+/g, " ").trim().slice(0, size);

const decodeReadme = (content) => {
  try {
    return decodeURIComponent(
      Array.from(atob(content.replace(/\n/g, "")), (character) =>
        `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    );
  } catch {
    return "";
  }
};

const suspiciousness = (repo) => {
  const staleDays = Math.floor((Date.now() - new Date(repo.pushed_at).getTime()) / 86_400_000);

  return (
    (repo.stargazers_count === 0 ? 28 : 0) +
    (repo.description ? 0 : 16) +
    (repo.language ? 0 : 12) +
    (repo.size === 0 ? 25 : 0) +
    (repo.archived ? 16 : 0) +
    (staleDays > 730 ? 20 : staleDays > 365 ? 10 : 0) +
    (/test|latihan|coba|baru|tugas|belajar/i.test(repo.name) ? 10 : 0)
  );
};

const mapWithConcurrency = async (items, limit, callback) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const summarizeContributions = (calendar) => {
  const days = (calendar.weeks || []).flatMap((week) => week.contributionDays || []);
  const activeDays = days.filter((day) => day.contributionCount > 0);
  let currentStreak = 0;
  let longestStreak = 0;

  for (const day of days) {
    if (day.contributionCount > 0) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const perMonth = new Map();
  for (const day of activeDays) {
    const month = day.date.slice(0, 7);
    perMonth.set(month, (perMonth.get(month) || 0) + day.contributionCount);
  }

  const busiestMonth = [...perMonth.entries()]
    .sort((a, b) => b[1] - a[1])[0];

  return {
    totalLastYear: calendar.totalContributions || 0,
    activeDays: activeDays.length,
    longestStreak,
    maxContributionsInOneDay: Math.max(0, ...days.map((day) => day.contributionCount)),
    busiestMonth: busiestMonth ? { month: busiestMonth[0], contributions: busiestMonth[1] } : null,
  };
};

const parseTotalCommitCount = (linkHeader, fallback) => {
  const lastPage = linkHeader?.match(/[?&]page=(\d+)>; rel="last"/)?.[1];
  return lastPage ? Number(lastPage) * 100 : fallback;
};

const summarizeCommitPattern = (commits, totalCommits) => {
  const perDay = new Map();

  for (const commit of commits) {
    const date = commit.commit?.author?.date || commit.commit?.committer?.date;
    if (!date) continue;
    const day = date.slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }

  const activeDates = [...perDay.keys()].sort();
  const gaps = activeDates.slice(1).map((date, index) => {
    const previous = new Date(`${activeDates[index]}T00:00:00Z`);
    const current = new Date(`${date}T00:00:00Z`);
    return Math.round((current - previous) / 86_400_000);
  });

  return {
    totalCommits,
    sampledCommits: commits.length,
    activeCommitDays: activeDates.length,
    maxCommitsInOneDay: Math.max(0, ...perDay.values()),
    averageGapDays: gaps.length
      ? Math.round((gaps.reduce((total, gap) => total + gap, 0) / gaps.length) * 10) / 10
      : 0,
    longestGapDays: Math.max(0, ...gaps),
  };
};

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return response.status(405).json({ message: "Method tidak diizinkan." });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response.status(503).json({
      message: "Scanner GitHub belum dikonfigurasi. Tambahkan GITHUB_TOKEN di Vercel.",
    });
  }

  const username = String(request.query?.username || "").trim().replace(/^@/, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
    return response.status(400).json({ message: "Username GitHub-nya nggak valid." });
  }

  const githubHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const github = async (path) =>
    fetch(`${GITHUB_API}${path}`, { headers: githubHeaders });

  const getContributionSummary = async () => {
    const contributionResponse = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { ...githubHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Contributions($login: String!) {
          user(login: $login) {
            contributionsCollection {
              contributionCalendar {
                totalContributions
                weeks {
                  contributionDays {
                    date
                    contributionCount
                  }
                }
              }
            }
          }
        }`,
        variables: { login: username },
      }),
    });

    if (!contributionResponse.ok) return null;

    const data = await contributionResponse.json();
    const calendar = data.data?.user?.contributionsCollection?.contributionCalendar;
    return calendar ? summarizeContributions(calendar) : null;
  };

  const inspectRepo = async (repo) => {
    const base = `/repos/${repo.full_name}`;
    const [readmeResponse, treeResponse, languagesResponse, commitsResponse] = await Promise.all([
      github(`${base}/readme`),
      github(`${base}/git/trees/${encodeURIComponent(repo.default_branch || "main")}?recursive=1`),
      github(`${base}/languages`),
      github(`${base}/commits?author=${encodeURIComponent(username)}&per_page=100`),
    ]);

    const readme = readmeResponse.ok ? await readmeResponse.json() : null;
    const tree = treeResponse.ok ? await treeResponse.json() : { tree: [] };
    const languages = languagesResponse.ok ? await languagesResponse.json() : {};
    const commits = commitsResponse.ok ? await commitsResponse.json() : [];
    const commitPattern = summarizeCommitPattern(
      commits,
      parseTotalCommitCount(commitsResponse.headers.get("link"), commits.length),
    );
    const files = (tree.tree || []).filter((item) => item.type === "blob").map((item) => item.path);
    const folders = [
      ...new Set(
        (tree.tree || [])
          .filter((item) => item.type === "tree")
          .map((item) => item.path.split("/")[0]),
      ),
    ].slice(0, 12);

    return {
      name: repo.name,
      url: repo.html_url,
      description: clip(repo.description, 300),
      primaryLanguage: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      sizeKb: repo.size,
      archived: repo.archived,
      lastPushedAt: repo.pushed_at,
      readmePresent: Boolean(readme),
      readmeSnippet: clip(readme ? decodeReadme(readme.content) : "", 900),
      fileCount: files.length,
      folders,
      filePaths: files.slice(0, 55),
      languages: Object.keys(languages),
      commitPattern,
    };
  };

  try {
    const [profileResponse, reposResponse, contributions] = await Promise.all([
      github(`/users/${encodeURIComponent(username)}`),
      github(`/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`),
      getContributionSummary(),
    ]);

    if (profileResponse.status === 404) {
      return response.status(404).json({
        message: "Akun GitHub-nya nggak ketemu. Jangan-jangan username sendiri juga lupa?",
      });
    }

    if (!profileResponse.ok || !reposResponse.ok) {
      const reset = profileResponse.headers.get("x-ratelimit-reset") || reposResponse.headers.get("x-ratelimit-reset");
      const resetAt = reset ? new Date(Number(reset) * 1000).toLocaleTimeString("id-ID") : null;
      return response.status(502).json({
        message: resetAt
          ? `GitHub lagi membatasi scan. Coba lagi setelah ${resetAt}.`
          : "GitHub lagi ngambek. Coba lagi sebentar lagi.",
      });
    }

    const profile = await profileResponse.json();
    const repos = await reposResponse.json();
    const targets = repos
      .filter((repo) => !repo.fork)
      .sort((a, b) => suspiciousness(b) - suspiciousness(a))
      .slice(0, 6);

    if (!targets.length) {
      return response.status(404).json({ message: "Nggak ada repo non-fork yang bisa dibongkar." });
    }

    const inspected = await mapWithConcurrency(targets, 2, inspectRepo);
    const fileCount = inspected.reduce((total, repo) => total + repo.fileCount, 0);

    response.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    return response.status(200).json({
      profile: {
        login: profile.login,
        name: profile.name,
        avatar_url: profile.avatar_url,
        html_url: profile.html_url,
        followers: profile.followers,
        public_repos: profile.public_repos,
      },
      repositories: { items: inspected, fileCount },
      contributions,
    });
  } catch (error) {
    console.error("[api/scan] Error saat membongkar GitHub", {
      message: error instanceof Error ? error.message : String(error),
    });
    return response.status(502).json({ message: "Scanner GitHub lagi kepanasan. Coba lagi." });
  }
}
