# Build from stacks/51d7cf9e:  docker build -f sap-mock/Dockerfile -t eimrf-sap-mock .
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY sap-mock/SapMock.csproj sap-mock/
RUN dotnet restore sap-mock/SapMock.csproj
COPY sap-mock/ sap-mock/
RUN dotnet publish sap-mock/SapMock.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
COPY config/demo-profile.json /config/demo-profile.json
ENV ProfileConfig=/config/demo-profile.json \
    ASPNETCORE_URLS=http://0.0.0.0:8400
EXPOSE 8400
ENTRYPOINT ["dotnet", "SapMock.dll"]
