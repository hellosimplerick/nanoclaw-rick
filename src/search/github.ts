export type GitHubFork = {
    full_name: string;
    html_url: string;
    stargazers_count: number;
    updated_at: string;
};

export async function fetchRepoForks(owner: string, repo: string) {
    const url = `https://api.github.com/repos/${owner}/${repo}/forks?per_page=10`;

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/vnd.github+json',
        },
    });

    if (!response.ok) {
        console.warn(
            `[githubSearch] Failed: ${response.status} ${response.statusText}`,
        );
        return [];
    }

    const data = (await response.json()) as GitHubFork[];

    return data.slice(0, 5);
}

export function formatForkResults(
    owner: string,
    repo: string,
    forks: GitHubFork[],
): string {
    const lines: string[] = [];
    lines.push('[GitHub Fork Results]');
    lines.push(`Repository: ${owner}/${repo}`);

    if (forks.length === 0) {
        lines.push('No forks found.');
        return lines.join('\n') + '\n---\n';
    }

    for (let i = 0; i < forks.length; i++) {
        const f = forks[i];
        lines.push(
            `${i + 1}. ${f.full_name} — ${f.html_url} (⭐ ${f.stargazers_count})`,
        );
    }

    return lines.join('\n') + '\n---\n';
}
