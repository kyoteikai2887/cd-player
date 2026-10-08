/** Shared write validation; never accepts arbitrary keys from a patch. */
export function validateMetadataPatch(
  patch: Record<string, unknown>,
  album: boolean,
): boolean {
  const allowed = album
    ? [
        'title',
        'albumArtists',
        'albumArtistCredit',
        'workTitle',
        'releaseYear',
        'catalogNumber',
        'label',
        'language',
        'titleSort',
        'discs',
      ]
    : [
        'title',
        'artists',
        'artistCredit',
        'discNumber',
        'trackNumber',
        'language',
        'versionKind',
        'versionLabel',
      ];
  return Object.entries(patch).every(([key, value]) => {
    if (!allowed.includes(key)) return false;
    if (['albumArtists', 'artists'].includes(key))
      return (
        Array.isArray(value) && value.every((item) => typeof item === 'string')
      );
    if (key === 'discs')
      return (
        Array.isArray(value) &&
        value.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            Number.isInteger(item.number) &&
            item.number > 0 &&
            (item.title === undefined || typeof item.title === 'string'),
        )
      );
    if (['discNumber', 'trackNumber'].includes(key))
      return Number.isInteger(value) && Number(value) > 0;
    if (key === 'releaseYear')
      return (
        value === null ||
        (Number.isInteger(value) && Number(value) > 0 && Number(value) <= 9999)
      );
    if (['title', 'albumArtistCredit', 'artistCredit'].includes(key))
      return typeof value === 'string' && !!value.trim();
    if (key === 'versionKind')
      return (
        value === null ||
        [
          'full',
          'short',
          'live',
          'instrumental',
          'offVocal',
          'remix',
          'other',
        ].includes(String(value))
      );
    return value === null || typeof value === 'string';
  });
}
