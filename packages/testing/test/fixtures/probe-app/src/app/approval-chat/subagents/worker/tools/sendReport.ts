export default async function sendReport(input: { to: string }): Promise<string> {
  return `report sent to ${input.to}`
}
