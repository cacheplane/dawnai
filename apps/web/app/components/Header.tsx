import { getGitHubStats } from "../../lib/github-stars"
import { HeaderInner } from "./HeaderInner"

export async function Header() {
  const stats = await getGitHubStats()
  return <HeaderInner stars={stats.stars} repoUrl={stats.url} />
}
