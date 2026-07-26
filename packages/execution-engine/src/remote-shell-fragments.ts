
export function buildPortableBase64DecodeFunction(functionName = 'invoker_base64_decode'): string {
  return `${functionName}() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  elif base64 -d </dev/null >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}`;
}

export function buildSourceInvokerEnvScript(remoteInvokerHome = '~/.invoker', varName = 'INVOKER_RUNTIME_HOME'): string {
  return `${varName}='${remoteInvokerHome.replace(/'/g, `'\\''`)}'
if [[ "$${varName}" == '~' ]]; then
  ${varName}="$HOME"
elif [[ "\${${varName}:0:2}" == '~/' ]]; then
  ${varName}="$HOME/\${${varName}:2}"
fi
INVOKER_ENV_FILE="$${varName}/env.sh"
if [ -f "$INVOKER_ENV_FILE" ]; then
  . "$INVOKER_ENV_FILE"
fi`;
}
