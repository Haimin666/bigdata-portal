/** Return whether a SQL segment contains executable text after leading comments. */
export function hasExecutableSql(sql) {
  let i = 0
  while (i < sql.length) {
    while (/\s/.test(sql[i] || '')) i++
    if (i >= sql.length) return false
    if (sql.startsWith('--', i) || sql[i] === '#') {
      const newline = sql.indexOf('\n', i)
      if (newline < 0) return false
      i = newline + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return false
      i = end + 2
      continue
    }
    return true
  }
  return false
}
