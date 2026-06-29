# infra/README.md
# Infrastructure Deployment Guide

This directory contains an Azure Bicep template that provisions the Azure resources
required to run the voicelive-webrtc-starter.

## What Gets Deployed

| Resource | Details |
|---|---|
| **Azure AI Services** | Kind: `AIServices`, SKU: `S0` — provides both Voice Live and Azure OpenAI endpoints |
| **GPT-4o deployment** | Model: `gpt-4o`, SKU: `GlobalStandard`, Capacity: 10K TPM |

> **Note:** The same Azure AI Services endpoint is used for both Voice Live sessions
> and the GPT-4o extraction agent. No separate Azure OpenAI resource is needed.

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) ≥ 2.60
- An Azure subscription with the `Contributor` role on a resource group
- Azure AI Services / Voice Live availability in your target region
  (check [product availability by region](https://azure.microsoft.com/explore/global-infrastructure/products-by-region/))

## Deploy with Azure CLI

```bash
# 1. Log in
az login

# 2. Create a resource group (or use an existing one)
az group create --name rg-voicelive-starter --location eastus

# 3. Deploy the Bicep template
az deployment group create \
  --resource-group rg-voicelive-starter \
  --template-file main.bicep \
  --parameters resourceToken=$(openssl rand -hex 4)
```

The deployment outputs three values:

```
endpoint              = https://<name>.cognitiveservices.azure.com/
accountName           = ai-<token>
openaiDeploymentName  = gpt-4o
```

Copy the `endpoint` value into your `.env` file:

```dotenv
AZURE_VOICELIVE_ENDPOINT=https://<name>.cognitiveservices.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

## Get the API Key (for local development)

```bash
az cognitiveservices account keys list \
  --name ai-<token> \
  --resource-group rg-voicelive-starter \
  --query key1 -o tsv
```

Set this as `AZURE_VOICELIVE_API_KEY` in `.env`.

## Production: Use Managed Identity (no API key)

In production, assign the `Cognitive Services User` role to your compute's managed identity
and leave `AZURE_VOICELIVE_API_KEY` empty. The backend will automatically use
`DefaultAzureCredential`.

```bash
az role assignment create \
  --assignee <managed-identity-principal-id> \
  --role "Cognitive Services User" \
  --scope $(az cognitiveservices account show \
    --name ai-<token> \
    --resource-group rg-voicelive-starter \
    --query id -o tsv)
```

## Clean Up

```bash
az group delete --name rg-voicelive-starter --yes
```
