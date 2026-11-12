CLUSTER := relay
IMAGE   := relay:latest
URL     := http://localhost:8080

.PHONY: cluster metrics-server build load deploy up status logs loadtest clean

cluster:
	kind create cluster --config kind-config.yaml

metrics-server:
	kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
	kubectl -n kube-system patch deployment metrics-server --type=json \
	  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

build:
	docker build -t $(IMAGE) app

load:
	kind load docker-image $(IMAGE) --name $(CLUSTER)

deploy:
	kubectl apply -f k8s/
	kubectl -n relay rollout restart deployment/relay
	kubectl -n relay rollout status deployment/relay --timeout=180s

up: cluster metrics-server build load deploy

status:
	kubectl -n relay get deploy,pods,svc,hpa -o wide

logs:
	kubectl -n relay logs -l app=relay --tail=100 --prefix

# make loadtest RPS=150 DURATION=300
RPS      ?= 150
DURATION ?= 300
loadtest:
	node tools/load.js --url $(URL) --rps $(RPS) --duration $(DURATION)

clean:
	kind delete cluster --name $(CLUSTER)
