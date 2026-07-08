{{/*
Chart name, truncated and trimmed for use in labels.
*/}}
{{- define "dawn-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated to 63 chars (DNS label limit) since
this is used to construct Kubernetes object names.
*/}}
{{- define "dawn-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Standard Helm recommended labels.
*/}}
{{- define "dawn-app.labels" -}}
app.kubernetes.io/name: {{ include "dawn-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: Helm
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/*
Selector labels — the stable subset used to match Pods (Deployment
selector, Service selector, PDB selector). Must NOT change across
releases/upgrades.
*/}}
{{- define "dawn-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dawn-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The ServiceAccount name to use, honoring create vs. reuse-existing.
*/}}
{{- define "dawn-app.serviceAccountName" -}}
{{- .Values.serviceAccount.name -}}
{{- end -}}
