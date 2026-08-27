interface Props {
  readonly data: unknown
}

export function JsonLd({ data }: Props) {
  const json = JSON.stringify(data)?.replaceAll("<", "\\u003c") ?? "null"

  // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON is serialized and less-than escaped above.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
}
