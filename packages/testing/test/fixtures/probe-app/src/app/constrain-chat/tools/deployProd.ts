export default async function deployProd(input: { env: string }): Promise<string> {
  return `deployed to ${input.env}`
}
