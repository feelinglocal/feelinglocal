# Deployment Guide

This directory contains all the necessary configurations and scripts for deploying the Localization App to various cloud platforms with scale and reliability features (M5) and comprehensive deployment strategies (M6).

## 🚀 Quick Start

### Docker Deployment
```bash
# Build and run locally
npm run docker:build
npm run docker:run

# Or use Docker Compose
npm run docker:compose:prod
```

### Kubernetes Deployment
```bash
# Deploy to Kubernetes
kubectl apply -f deploy/kubernetes/

# Or use the deployment script
npm run k8s:deploy
```

### Helm Deployment
```bash
# Install with Helm
helm install localization-app deploy/helm

# Upgrade existing deployment
helm upgrade localization-app deploy/helm
```

## 📁 Directory Structure

```
deploy/
├── kubernetes/          # Kubernetes manifests
│   ├── namespace.yaml
│   ├── secrets.yaml     # Template - configure actual secrets
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── storage.yaml
│   ├── rbac.yaml
│   └── hpa.yaml
├── terraform/           # Infrastructure as Code
│   └── main.tf         # AWS EKS + supporting services
├── helm/               # Helm chart
│   ├── Chart.yaml
│   └── values.yaml
├── scripts/            # Deployment scripts
│   ├── deploy.sh       # Main deployment script
│   └── health-check.sh # Health check utilities
├── blue-green-deploy.js # Blue-green deployment logic
└── README.md           # This file
```

## 🔧 M5: Scale & Reliability Features

### Job Queue System (BullMQ)
- **Long-running translations**: Handles large documents in background
- **File processing**: Queued document translation with progress tracking
- **Batch processing**: High-throughput batch translations
- **Worker concurrency**: Configurable concurrency per job type

### Circuit Breaker (Opossum)
- **OpenAI API protection**: Fail-fast when OpenAI is unavailable
- **Automatic recovery**: Self-healing when service recovers
- **Fallback responses**: Graceful degradation during outages
- **Configurable thresholds**: Customizable error rates and timeouts

### Enhanced Timeouts
- **Operation-specific timeouts**: Different timeouts for different operations
- **Retry logic**: Exponential backoff with jitter
- **Timeout tracking**: Monitor timeout rates and patterns
- **Graceful degradation**: Handle timeouts without crashing

### Micro-batching
- **Token budget management**: Intelligent chunking based on token limits
- **Throughput optimization**: Combine multiple requests efficiently
- **Rate limit compliance**: Respect OpenAI rate limits automatically

## 🏗️ M6: Packaging & Deployment

### Multi-stage Docker Build
- **Optimized images**: Separate build and runtime stages
- **Security**: Non-root user, minimal attack surface
- **Caching**: Efficient layer caching for faster builds
- **Multi-platform**: Support for AMD64 and ARM64

### CI/CD Pipeline (GitHub Actions)
- **Automated testing**: Unit tests, security scans, container tests
- **Multi-stage builds**: Test, build, and deploy stages
- **Security scanning**: Vulnerability scanning with Trivy and Snyk
- **Automated releases**: Tag-based releases with changelog generation

### Cloud Deployment
- **Kubernetes**: Production-ready manifests with HPA, PDB, monitoring
- **Terraform**: Infrastructure as Code for AWS EKS
- **Helm**: Parameterized deployments with values customization
- **Multi-cloud**: Portable configurations

### Blue-Green Deployment
- **Zero-downtime deployments**: Gradual traffic switching
- **Health monitoring**: Comprehensive health checks
- **Automatic rollback**: Rollback on failure detection
- **Traffic monitoring**: Real-time metrics during deployment

## 🔐 Security & Secret Management

### Kubernetes Secrets
```bash
# Create secrets (replace with actual values)
kubectl create secret generic localization-app-secrets \
  --from-literal=OPENAI_API_KEY=your-actual-key \
  --from-literal=SESSION_SECRET=your-session-secret \
  -n localization-app
```

### AWS Secrets Manager (Terraform)
```bash
# Apply Terraform configuration
cd deploy/terraform
terraform init
terraform plan -var="openai_api_key=your-key"
terraform apply
```

## 📊 Monitoring & Observability

### Prometheus Metrics
The application exposes comprehensive metrics at `/metrics`:
- HTTP request metrics
- Translation metrics
- Queue metrics
- Circuit breaker metrics
- Resource usage metrics

### Health Checks
Multiple health check endpoints:
- `/api/health` - Basic health
- `/api/health/detailed` - Comprehensive health including dependencies

### Logging
Structured logging with multiple levels:
- Request/response logging
- Job processing logs
- Error tracking with Sentry integration

## 🚦 Deployment Strategies

### Rolling Deployment (Default)
```bash
# Standard Kubernetes rolling update
kubectl set image deployment/localization-app app=ghcr.io/your-org/localization-app:v1.2.0
```

### Blue-Green Deployment
```bash
# Use the deployment script
PLATFORM=kubernetes IMAGE_TAG=ghcr.io/your-org/localization-app:v1.2.0 ./deploy/scripts/deploy.sh
```

### Canary Deployment (with Istio)
```bash
# Deploy canary version
kubectl apply -f deploy/kubernetes/canary.yaml
```

## 🛠️ Configuration

### Environment Variables
See `.env.example` for all configuration options:

#### M5 Configuration
- `REDIS_URL`: Redis connection for job queues
- `*_WORKER_CONCURRENCY`: Worker concurrency per job type
- `OPENAI_*_TIMEOUT`: Timeout configurations
- `*_ERROR_THRESHOLD`: Circuit breaker thresholds

#### M6 Configuration
- `POST_DEPLOY_MONITORING_DURATION`: Post-deployment monitoring time
- `POST_DEPLOY_CHECK_INTERVAL`: Health check frequency

### Platform-Specific Configuration

#### Kubernetes
- Resource requests/limits in `deployment.yaml`
- HPA settings in `hpa.yaml`
- Storage classes in `storage.yaml`

#### Helm
- All configurations in `helm/values.yaml`
- Override with `--set` or custom values files

#### Terraform
- AWS-specific settings in `terraform/main.tf`
- Variable definitions for different environments

## 🚨 Troubleshooting

### Common Issues

1. **Queue system not starting**
   ```bash
   # Check Redis connection
   docker run --rm redis:7.4-alpine redis-cli -h your-redis-host ping
   ```

2. **Circuit breaker always open**
   ```bash
   # Check OpenAI API key and connectivity
   curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
   ```

3. **Deployment fails**
   ```bash
   # Check deployment logs
   kubectl logs -f deployment/localization-app -n localization-app
   
   # Check health status
   npm run health:check
   ```

4. **High memory usage**
   ```bash
   # Check queue depth and worker count
   curl http://localhost:3000/api/admin/queues
   ```

### Rollback Procedures

#### Kubernetes
```bash
# Rollback deployment
kubectl rollout undo deployment/localization-app -n localization-app

# Or use the script
npm run deploy:rollback
```

#### Helm
```bash
# Rollback to previous release
helm rollback localization-app -n localization-app
```

## 📈 Scaling

### Horizontal Scaling
- **Kubernetes HPA**: Automatically scale based on CPU/memory
- **Manual scaling**: `kubectl scale deployment localization-app --replicas=5`

### Vertical Scaling
- Update resource limits in deployment manifests
- Consider worker concurrency settings

### Queue Scaling
- Adjust worker concurrency via environment variables
- Monitor queue depth and processing times
- Scale Redis if needed for high queue volume

## 🔄 Maintenance

### Regular Tasks
1. **Monitor metrics**: Check Prometheus/Grafana dashboards
2. **Review logs**: Check for errors and performance issues
3. **Update dependencies**: Regular security updates
4. **Backup verification**: Ensure backups are working
5. **Performance tuning**: Adjust concurrency and timeout settings

### Upgrades
1. **Test in staging**: Always test new versions in staging first
2. **Blue-green deployment**: Use for zero-downtime upgrades
3. **Database migrations**: Handle schema changes carefully
4. **Configuration updates**: Update ConfigMaps/Secrets as needed

For more detailed information, see the main README.md in the project root.
