/**
 * Russian text for a non-2xx answer, so a raw `HTTP 500` never reaches the operator.
 *
 * @param status HTTP status code of the response.
 * @returns Message for an error banner.
 */
export function describeHttpStatus(status: number): string {
  return `Сервер вернул ошибку (код ${status}).`;
}

/**
 * Maps a failed request to Russian text, so a raw `HTTP 500` or `Failed to fetch`
 * never reaches the operator.
 *
 * @param error Value caught from a request; an `Error` whose message is `HTTP <status>`
 *   (thrown after a non-2xx response) is reported with its status code.
 * @returns Message for an error banner.
 */
export function describeLoadError(error: unknown): string {
  const status = error instanceof Error ? /^HTTP (\d+)$/.exec(error.message)?.[1] : undefined;
  return status
    ? describeHttpStatus(Number(status))
    : 'Не удалось связаться с сервером. Проверьте подключение.';
}
