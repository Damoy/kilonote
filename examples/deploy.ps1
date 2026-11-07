# An example for the syntax coloring only: KiloNote never runs files.
param(
    [string]$Environment = "staging",
    [int]$Replicas = 2
)

$services = @("api", "worker")
foreach ($service in $services) {
    Write-Host "Would deploy $service to $Environment ($Replicas replicas)"
}
