FROM maven:3.8.8-eclipse-temurin-8 AS build
WORKDIR /src
COPY maven-settings.xml /root/.m2/settings.xml
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

# Runtime: Java 8 + GnuCOBOL (HLDPOST ledger posting program)
FROM maven:3.8.8-eclipse-temurin-8
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gnucobol3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY cobol ./cobol
RUN mkdir -p bin && cobc -x -free -o bin/HLDPOST cobol/HLDPOST.cbl
COPY --from=build /src/target/resort-inventory.jar app.jar
ENV JAVA_OPTS="-Xms64m -Xmx160m -XX:+UseSerialGC"
EXPOSE 8080
CMD ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
