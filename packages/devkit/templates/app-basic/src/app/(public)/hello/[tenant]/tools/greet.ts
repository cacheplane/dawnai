export default async (input: unknown) => {
  const { tenant } = input as { readonly tenant: string }

  return {
    greeting: `Hello, ${tenant}!`,
  }
}
