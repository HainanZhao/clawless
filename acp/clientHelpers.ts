export function buildPermissionResponse(options: any[], permissionStrategy: string) {
  if (!Array.isArray(options) || options.length === 0) {
    return { outcome: { outcome: 'cancelled' } };
  }

  if (permissionStrategy === 'cancelled') {
    return { outcome: { outcome: 'cancelled' } };
  }

  const preferred = options.find((option: any) => option.kind === permissionStrategy);
  const selectedOption = preferred || options[0];

  return {
    outcome: {
      outcome: 'selected',
      optionId: selectedOption.optionId,
    },
  };
}

export async function noOpAcpFileOperation(_params: any) {
  return {};
}
