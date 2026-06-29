// infra/main.bicep
// ----------------
// Azure Bicep template for the voicelive-webrtc-starter.
//
// Deploys:
//   - Azure AI Services account (kind: AIServices) with Voice Live enabled
//   - GPT-4o model deployment for both Voice Live and the extraction agent
//
// Deploy with Azure CLI:
//   az deployment sub create \
//     --location eastus \
//     --template-file main.bicep \
//     --parameters resourceToken=<unique-suffix>
//
// Or with Azure Developer CLI (azd):
//   azd up  (requires azure.yaml in the repo root)

targetScope = 'resourceGroup'

// ── Parameters ────────────────────────────────────────────────────────────

@description('Azure region for all resources.')
param location string = 'eastus'

@description('Unique suffix appended to resource names to avoid collisions.')
param resourceToken string

@description('Resource tags applied to all resources.')
param tags object = {
  project: 'voicelive-webrtc-starter'
}

// ── Variables ─────────────────────────────────────────────────────────────

var aiServicesName = 'ai-${resourceToken}'

// ── Azure AI Services account ─────────────────────────────────────────────

resource aiServices 'Microsoft.CognitiveServices/accounts@2024-04-01-preview' = {
  name: aiServicesName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    // Public network access — restrict in production using privateEndpoints
    publicNetworkAccess: 'Enabled'
    // Disable local authentication to require Azure AD tokens in production.
    // Set to false (allow key auth) for local development convenience.
    disableLocalAuth: false
  }
}

// ── GPT-4o model deployment ───────────────────────────────────────────────
// This single deployment is used by both the Voice Live session (as the
// underlying language model) and by the extraction agent (via Azure OpenAI API).

resource gpt4oDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-04-01-preview' = {
  parent: aiServices
  name: 'gpt-4o'
  sku: {
    name: 'GlobalStandard'
    capacity: 10  // 10K tokens-per-minute — enough for demo workloads
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4o'
    }
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────
// Copy these values into your .env file.

@description('Azure AI Services endpoint — set as AZURE_VOICELIVE_ENDPOINT')
output endpoint string = aiServices.properties.endpoint

@description('Azure AI Services account name')
output accountName string = aiServices.name

@description('GPT-4o deployment name — set as AZURE_OPENAI_DEPLOYMENT')
output openaiDeploymentName string = gpt4oDeployment.name
