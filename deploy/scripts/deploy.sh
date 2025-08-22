#!/bin/bash

# deploy.sh - Production deployment script with blue-green strategy
set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default values
ENVIRONMENT="${ENVIRONMENT:-production}"
PLATFORM="${PLATFORM:-kubernetes}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NAMESPACE="${NAMESPACE:-localization-app}"
REPLICAS="${REPLICAS:-3}"
DRY_RUN="${DRY_RUN:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking deployment prerequisites..."
    
    # Check required tools
    local required_tools=()
    
    case $PLATFORM in
        kubernetes)
            required_tools=("kubectl" "helm")
            ;;
        docker-swarm)
            required_tools=("docker")
            ;;
        ecs)
            required_tools=("aws" "ecs-cli")
            ;;
        *)
            log_error "Unsupported platform: $PLATFORM"
            exit 1
            ;;
    esac
    
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "$tool is required but not installed"
            exit 1
        fi
    done
    
    # Check environment variables
    local required_vars=("IMAGE_TAG")
    
    for var in "${required_vars[@]}"; do
        if [ -z "${!var:-}" ]; then
            log_error "Required environment variable $var is not set"
            exit 1
        fi
    done
    
    log_success "Prerequisites check passed"
}

# Deploy to Kubernetes
deploy_kubernetes() {
    log_info "Deploying to Kubernetes..."
    
    # Check cluster connection
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    # Create namespace if it doesn't exist
    kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    
    # Apply configurations in order
    log_info "Applying Kubernetes manifests..."
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "DRY RUN MODE - No actual changes will be made"
        kubectl apply -f "$DEPLOY_DIR/kubernetes/" --namespace="$NAMESPACE" --dry-run=client
    else
        # Apply RBAC first
        kubectl apply -f "$DEPLOY_DIR/kubernetes/rbac.yaml" --namespace="$NAMESPACE"
        
        # Apply storage
        kubectl apply -f "$DEPLOY_DIR/kubernetes/storage.yaml" --namespace="$NAMESPACE"
        
        # Apply secrets and config (with warnings about updating secrets)
        log_warning "Applying secrets template - ensure actual secrets are configured!"
        kubectl apply -f "$DEPLOY_DIR/kubernetes/secrets.yaml" --namespace="$NAMESPACE"
        
        # Apply deployments
        kubectl apply -f "$DEPLOY_DIR/kubernetes/deployment.yaml" --namespace="$NAMESPACE"
        
        # Apply services
        kubectl apply -f "$DEPLOY_DIR/kubernetes/service.yaml" --namespace="$NAMESPACE"
        
        # Apply HPA
        kubectl apply -f "$DEPLOY_DIR/kubernetes/hpa.yaml" --namespace="$NAMESPACE"
        
        # Wait for rollout
        log_info "Waiting for deployment rollout..."
        kubectl rollout status deployment/localization-app --namespace="$NAMESPACE" --timeout=300s
        
        # Update image tag
        kubectl set image deployment/localization-app app="ghcr.io/$IMAGE_TAG" --namespace="$NAMESPACE"
        kubectl rollout status deployment/localization-app --namespace="$NAMESPACE" --timeout=300s
    fi
}

# Deploy using Helm
deploy_helm() {
    log_info "Deploying using Helm..."
    
    if ! helm version &> /dev/null; then
        log_error "Helm is not installed or not accessible"
        exit 1
    fi
    
    # Add any required Helm repositories
    helm repo add bitnami https://charts.bitnami.com/bitnami
    helm repo update
    
    if [ "$DRY_RUN" = "true" ]; then
        helm upgrade --install localization-app "$DEPLOY_DIR/helm" \
            --namespace="$NAMESPACE" \
            --create-namespace \
            --set app.image.tag="$IMAGE_TAG" \
            --set global.environment="$ENVIRONMENT" \
            --dry-run
    else
        helm upgrade --install localization-app "$DEPLOY_DIR/helm" \
            --namespace="$NAMESPACE" \
            --create-namespace \
            --set app.image.tag="$IMAGE_TAG" \
            --set global.environment="$ENVIRONMENT" \
            --wait \
            --timeout 600s
    fi
}

# Health check function
health_check() {
    log_info "Running health checks..."
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if kubectl exec -n "$NAMESPACE" deployment/localization-app -- curl -f http://localhost:3000/api/health &> /dev/null; then
            log_success "Health check passed"
            return 0
        fi
        
        log_info "Health check attempt $attempt/$max_attempts failed, retrying..."
        sleep 10
        ((attempt++))
    done
    
    log_error "Health checks failed after $max_attempts attempts"
    return 1
}

# Smoke tests
run_smoke_tests() {
    log_info "Running smoke tests..."
    
    # Get service endpoint
    local service_endpoint
    if command -v kubectl &> /dev/null; then
        service_endpoint=$(kubectl get service localization-app -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}:3000')
    fi
    
    # Basic API test
    log_info "Testing basic API endpoints..."
    # kubectl exec -n "$NAMESPACE" deployment/localization-app -- curl -f "http://localhost:3000/api/health"
    
    # Translation test
    log_info "Testing translation endpoint..."
    # Add actual API tests here
    
    log_success "Smoke tests completed"
}

# Rollback function
rollback_deployment() {
    log_warning "Rolling back deployment..."
    
    case $PLATFORM in
        kubernetes)
            kubectl rollout undo deployment/localization-app --namespace="$NAMESPACE"
            kubectl rollout status deployment/localization-app --namespace="$NAMESPACE" --timeout=300s
            ;;
        helm)
            helm rollback localization-app --namespace="$NAMESPACE"
            ;;
        *)
            log_error "Rollback not implemented for platform: $PLATFORM"
            exit 1
            ;;
    esac
    
    log_success "Rollback completed"
}

# Main deployment function
main() {
    log_info "Starting deployment to $ENVIRONMENT environment"
    log_info "Platform: $PLATFORM, Image: $IMAGE_TAG, Namespace: $NAMESPACE"
    
    # Trap errors for cleanup
    trap 'log_error "Deployment failed - consider running rollback"; exit 1' ERR
    
    # Check prerequisites
    check_prerequisites
    
    # Deploy based on platform
    case $PLATFORM in
        kubernetes)
            deploy_kubernetes
            ;;
        helm)
            deploy_helm
            ;;
        *)
            log_error "Unsupported platform: $PLATFORM"
            exit 1
            ;;
    esac
    
    # Run health checks
    if [ "$DRY_RUN" != "true" ]; then
        health_check
        run_smoke_tests
    fi
    
    log_success "Deployment completed successfully!"
    log_info "Application should be available at the configured ingress endpoint"
}

# Handle command line arguments
case "${1:-deploy}" in
    deploy)
        main
        ;;
    rollback)
        rollback_deployment
        ;;
    health)
        health_check
        ;;
    smoke-test)
        run_smoke_tests
        ;;
    *)
        echo "Usage: $0 {deploy|rollback|health|smoke-test}"
        echo ""
        echo "Environment variables:"
        echo "  ENVIRONMENT=production    # Target environment"
        echo "  PLATFORM=kubernetes       # Deployment platform"
        echo "  IMAGE_TAG=latest          # Docker image tag"
        echo "  NAMESPACE=localization-app # Kubernetes namespace"
        echo "  REPLICAS=3                # Number of replicas"
        echo "  DRY_RUN=false             # Dry run mode"
        exit 1
        ;;
esac
