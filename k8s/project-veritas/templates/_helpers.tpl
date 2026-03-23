{{- define "project-veritas.name" -}}
project-veritas
{{- end -}}

{{- define "project-veritas.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "project-veritas.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "project-veritas.serviceName" -}}
{{- printf "%s-%s" (include "project-veritas.fullname" $) .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
