param(
    [string]$ResourceGroup = "ftcinterview-rg",
    [string]$Location = "eastus",
    [string]$NamePrefix = "vcad",
    [string]$ContainerAppsEnvironment = "ftcinterview-env",
    [string]$KeycloakAppName = "ftcinterview-auth",
    [string]$KeycloakBaseUrl = "https://auth.superpoweredjalapenos.org",
    [string]$KeycloakRealm = "ftc-interview",
    [string]$KeycloakClientId = "ftc-interview-web",
    [string]$KeycloakMasterEmails = "",
    [int]$MinReplicas = 1,
    [int]$MaxReplicas = 3
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
$env:NO_COLOR = "1"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & az @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $text = ($output | ForEach-Object { "$_" }) | Where-Object {
        $_ -notmatch "^WARNING: The behavior of this command has been altered by the following extension:"
    }
    $joined = (($text | Out-String).Trim())
    if ($exitCode -ne 0) {
        throw $joined
    }
    return $joined
}

function Test-Az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $null = & az @Arguments *>$null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function New-SafeSlug {
    param([string]$Value)
    $slug = ($Value.ToLowerInvariant() -replace "[^a-z0-9-]", "-").Trim("-")
    $slug = $slug -replace "-+", "-"
    if ([string]::IsNullOrWhiteSpace($slug) -or $slug[0] -notmatch "[a-z]") {
        $slug = "vcad-$slug"
    }
    return $slug
}

function New-AlphaNumericName {
    param([string]$Value, [int]$MaxLength = 50)
    $name = ($Value.ToLowerInvariant() -replace "[^a-z0-9]", "")
    if ([string]::IsNullOrWhiteSpace($name) -or $name[0] -notmatch "[a-z]") {
        $name = "vcad$name"
    }
    if ($name.Length -gt $MaxLength) {
        $name = $name.Substring(0, $MaxLength)
    }
    return $name
}

function ConvertTo-JsonBody {
    param($Value)
    return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

function Get-KeycloakAdminToken {
    param([string]$AdminPassword)
    $body = @{
        grant_type = "password"
        client_id = "admin-cli"
        username = "kcadmin"
        password = $AdminPassword
    }
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "$KeycloakBaseUrl/realms/master/protocol/openid-connect/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $body `
        -TimeoutSec 30 `
        -ErrorAction Stop
    return [string]$response.access_token
}

function Invoke-KeycloakAdmin {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Token,
        $Body = $null
    )
    $headers = @{ Authorization = "Bearer $Token" }
    $uri = "$KeycloakBaseUrl$Path"
    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 30 -ErrorAction Stop
    }
    return Invoke-RestMethod `
        -Method $Method `
        -Uri $uri `
        -Headers $headers `
        -ContentType "application/json" `
        -Body (ConvertTo-JsonBody $Body) `
        -TimeoutSec 30 `
        -ErrorAction Stop
}

function Ensure-KeycloakClientOrigin {
    param(
        [string]$AppUrl,
        [string]$Token
    )
    $matches = @(Invoke-KeycloakAdmin -Method Get -Path "/admin/realms/$KeycloakRealm/clients?clientId=$KeycloakClientId" -Token $Token)
    if ($matches.Count -eq 0) {
        throw "Keycloak client '$KeycloakClientId' was not found in realm '$KeycloakRealm'."
    }
    $client = $matches | Select-Object -First 1
    $clientId = [string]$client.id
    $full = Invoke-KeycloakAdmin -Method Get -Path "/admin/realms/$KeycloakRealm/clients/$clientId" -Token $Token
    $redirectUri = "$AppUrl/*"
    $origin = $AppUrl
    $redirectUris = @($full.redirectUris + $redirectUri) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $webOrigins = @($full.webOrigins + $origin) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $full.redirectUris = $redirectUris
    $full.webOrigins = $webOrigins
    Invoke-KeycloakAdmin -Method Put -Path "/admin/realms/$KeycloakRealm/clients/$clientId" -Token $Token -Body $full | Out-Null
    Write-Host "Keycloak redirect URI ensured: $redirectUri"
}

Push-Location $root
try {
    $account = (Invoke-Az account show --output json --only-show-errors) | ConvertFrom-Json
    $subscriptionId = [string]$account.id
    $suffix = ($subscriptionId -replace "[^a-zA-Z0-9]", "").Substring(0, 8).ToLowerInvariant()
    $slug = New-SafeSlug $NamePrefix
    $acrName = New-AlphaNumericName "$slug$suffix" 50
    $appName = "$slug-app"
    $imageName = "vcad-interview"
    $imageTag = Get-Date -Format "yyyyMMddHHmmss"
    $keycloakIssuer = "$($KeycloakBaseUrl.TrimEnd('/'))/realms/$KeycloakRealm"

    Write-Host "Using subscription: $($account.name) ($subscriptionId)"
    Write-Host "Resource group:     $ResourceGroup"
    Write-Host "Container app:      $appName"

    foreach ($namespace in @("Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry")) {
        $registrationState = ""
        try {
            $registrationState = Invoke-Az provider show --namespace $namespace --query "registrationState" --output tsv --only-show-errors
        } catch {}
        if ($registrationState -ne "Registered") {
            Invoke-Az provider register --namespace $namespace --wait --only-show-errors | Out-Null
        }
    }

    Invoke-Az group create --name $ResourceGroup --location $Location --only-show-errors | Out-Null

    if (-not (Test-Az acr show --name $acrName --resource-group $ResourceGroup --only-show-errors)) {
        Invoke-Az acr create --name $acrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true --only-show-errors | Out-Null
    }

    Write-Host "Building image in ACR..."
    $image = "$acrName.azurecr.io/$imageName`:$imageTag"
    Invoke-Az acr build --registry $acrName --image "$imageName`:$imageTag" --file Dockerfile --no-logs . --only-show-errors | Out-Null

    if (-not (Test-Az containerapp env show --name $ContainerAppsEnvironment --resource-group $ResourceGroup --only-show-errors)) {
        $logName = "$slug-logs"
        $workspace = Invoke-Az monitor log-analytics workspace create --resource-group $ResourceGroup --workspace-name $logName --location $Location --output json --only-show-errors | ConvertFrom-Json
        $workspaceId = [string]$workspace.customerId
        $workspaceKey = Invoke-Az monitor log-analytics workspace get-shared-keys --resource-group $ResourceGroup --workspace-name $logName --query primarySharedKey --output tsv --only-show-errors
        Invoke-Az containerapp env create --name $ContainerAppsEnvironment --resource-group $ResourceGroup --location $Location --logs-workspace-id $workspaceId --logs-workspace-key $workspaceKey --only-show-errors | Out-Null
    }

    $acr = Invoke-Az acr credential show --name $acrName --output json --only-show-errors | ConvertFrom-Json
    $acrUser = [string]$acr.username
    $acrPassword = [string]$acr.passwords[0].value
    $sessionSecret = [Convert]::ToBase64String([Guid]::NewGuid().ToByteArray()).TrimEnd("=")

    if (-not (Test-Az containerapp show --name $appName --resource-group $ResourceGroup --only-show-errors)) {
        Invoke-Az containerapp create `
            --name $appName `
            --resource-group $ResourceGroup `
            --environment $ContainerAppsEnvironment `
            --image $image `
            --target-port 8080 `
            --ingress external `
            --registry-server "$acrName.azurecr.io" `
            --registry-username $acrUser `
            --registry-password $acrPassword `
            --min-replicas $MinReplicas `
            --max-replicas $MaxReplicas `
            --env-vars `
                "PORT=8080" `
                "VCAD_AUTH_MODE=keycloak" `
                "VCAD_KEYCLOAK_BASE_URL=$KeycloakBaseUrl" `
                "VCAD_KEYCLOAK_REALM=$KeycloakRealm" `
                "VCAD_KEYCLOAK_CLIENT_ID=$KeycloakClientId" `
                "VCAD_KEYCLOAK_ISSUER=$keycloakIssuer" `
                "VCAD_KEYCLOAK_MASTER_EMAILS=$KeycloakMasterEmails" `
                "VCAD_SESSION_SECRET=$sessionSecret" `
            --only-show-errors | Out-Null
    } else {
        Invoke-Az containerapp update `
            --name $appName `
            --resource-group $ResourceGroup `
            --image $image `
            --min-replicas $MinReplicas `
            --max-replicas $MaxReplicas `
            --set-env-vars `
                "PORT=8080" `
                "VCAD_AUTH_MODE=keycloak" `
                "VCAD_KEYCLOAK_BASE_URL=$KeycloakBaseUrl" `
                "VCAD_KEYCLOAK_REALM=$KeycloakRealm" `
                "VCAD_KEYCLOAK_CLIENT_ID=$KeycloakClientId" `
                "VCAD_KEYCLOAK_ISSUER=$keycloakIssuer" `
                "VCAD_KEYCLOAK_MASTER_EMAILS=$KeycloakMasterEmails" `
                "VCAD_SESSION_SECRET=$sessionSecret" `
            --only-show-errors | Out-Null
    }

    $fqdn = Invoke-Az containerapp show --name $appName --resource-group $ResourceGroup --query "properties.configuration.ingress.fqdn" --output tsv --only-show-errors
    $appUrl = "https://$fqdn"
    Invoke-Az containerapp update --name $appName --resource-group $ResourceGroup --set-env-vars "PUBLIC_BASE_URL=$appUrl" --only-show-errors | Out-Null

    $adminPassword = Invoke-Az containerapp secret show `
        --name $KeycloakAppName `
        --resource-group $ResourceGroup `
        --secret-name admin-password `
        --query value `
        --output tsv `
        --only-show-errors
    if ([string]::IsNullOrWhiteSpace($adminPassword)) {
        throw "Could not read Keycloak admin secret from Container App $KeycloakAppName."
    }
    $token = Get-KeycloakAdminToken -AdminPassword $adminPassword
    Ensure-KeycloakClientOrigin -AppUrl $appUrl -Token $token

    Write-Host ""
    Write-Host "VCAD test app: $appUrl"
    Write-Host "Health:        $appUrl/api/health"
} finally {
    Pop-Location
}
